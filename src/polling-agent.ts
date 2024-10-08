import { Message, SQSClient } from "@aws-sdk/client-sqs";
import debug from "debug";
import { Consumer } from "sqs-consumer";
import { z } from "zod";
import { createClient } from "./create-client";
import { InferableError } from "./errors";
import { serializeError } from "./serialize-error";
import { executeFn, Result } from "./execute-fn";
import { FunctionRegistration } from "./types";
import { packer } from "./packer";
import { extractBlobs } from "./util";

export const log = debug("inferable:client:polling-agent");

export type PollingAgentService = {
  name: string;
  idleTimeout?: number;
  onIdle?: () => void;
};

export type PollingAgentOptions = {
  endpoint: string;
  machineId: string;
  apiSecret: string;
  service: PollingAgentService;
  ttl?: number;
  exitHandler: () => void;
  functionRegistry: { [key: string]: FunctionRegistration };
};

export class PollingAgent {
  private exitHandler: () => void;

  private client: ReturnType<typeof createClient>;
  private service: PollingAgentService;
  private sqsQueueUrl?: string;
  private sqsClient?: SQSClient;
  private consumer?: Consumer;
  private functionRegistry: { [key: string]: FunctionRegistration } = {};
  private pollingEnabled: boolean = true;
  private credentialsExpiration: Date | null = null;
  private clusterId: string | null = null;
  constructor(options: PollingAgentOptions) {
    this.service = options.service;
    this.exitHandler = options.exitHandler;
    this.functionRegistry = options.functionRegistry;

    this.client = createClient({
      baseUrl: options.endpoint,
      machineId: options.machineId,
      apiSecret: options.apiSecret,
    });
  }

  private async checkAndRestartIfNeeded() {
    if (!this.credentialsExpiration) {
      return;
    }

    const expired = new Date() > this.credentialsExpiration;

    const withinOneMinute =
      this.credentialsExpiration.getTime() - Date.now() < 60_000;

    if (expired || withinOneMinute) {
      log("Restarting to get new credentials", {
        expired,
        withinOneMinute,
      });

      await this.stop();
      this.consumer = undefined;
      await this.start();
    }
  }

  private async registerMachine(): Promise<{
    clusterId: string;
  }> {
    const functions = Object.entries(this.functionRegistry)
      .filter(([, { serviceName }]) => serviceName === this.service.name)
      .map(([functionName, registration]) => ({
        name: functionName,
        description: registration.description,
        schema: registration.schema.inputJson,
        config: registration.config,
      }));

    log("registering machine", {});

    const registerResult = await this.client.createMachine({
      headers: {
        "x-sentinel-no-mask": "1",
      },
      body: {
        service: this.service.name,
        functions,
      },
    });

    if (registerResult?.status !== 200) {
      log("Failed to register machine", registerResult);

      throw new InferableError("Failed to register machine", {
        status: registerResult.status,
        body: registerResult.body,
      });
    }

    this.sqsQueueUrl = registerResult.body.queueUrl;
    this.pollingEnabled = registerResult.body.enabled ?? true;
    this.credentialsExpiration = new Date(registerResult.body.expiration);
    this.sqsClient = new SQSClient({
      // Setting this explicitly, AWS_* variables seemed to be interfering.
      // Even with useQueueUrlAsEndpoint set.
      region: registerResult.body.region,
      credentials: {
        accessKeyId: registerResult.body.credentials.accessKeyId,
        secretAccessKey: registerResult.body.credentials.secretAccessKey,
        sessionToken: registerResult.body.credentials.sessionToken,
      },
    });

    if (this.consumer) {
      throw new Error("Consumer already started");
    }

    this.consumer = Consumer.create({
      queueUrl: this.sqsQueueUrl!,
      handleMessage: async (message) => {
        this.processMessage(message);
        return message;
      },
      sqs: this.sqsClient,
      pollingCompleteWaitTimeMs: 20_000,
      batchSize: 10,
    });

    this.consumer.on("error", async (err) => {
      log("Error in SQS consumer", err);

      await this.checkAndRestartIfNeeded();
    });

    this.consumer.on("empty", async () => {
      await this.checkAndRestartIfNeeded();
    });

    this.consumer.on("response_processed", async () => {
      await this.checkAndRestartIfNeeded();
    });

    this.consumer.on("processing_error", async (err) => {
      log("Processing error in SQS consumer", err);
    });

    this.consumer.on("stopped", () => {
      log("SQS consumer stopped");
      this.exitHandler();
    });

    this.consumer.on("message_received", (message) => {
      log("Message received", message);
    });

    this.consumer.on("message_processed", (message) => {
      log("Message processed", message);
    });

    this.consumer.on("waiting_for_polling_to_complete", () => {
      log("Waiting for polling to complete");
    });

    this.consumer.on("waiting_for_polling_to_complete_timeout_exceeded", () => {
      log("Waiting for polling to complete timeout exceeded");
    });

    if (this.pollingEnabled) {
      this.consumer.start();

      // wait until the consumer is ready
      await new Promise<void>((resolve) => {
        const check = () => {
          const consumerStatus = this.consumer?.status;

          log("Consumer status", consumerStatus);

          if (consumerStatus?.isPolling) {
            resolve();
          } else {
            setTimeout(check, 100);
          }
        };

        check();
      });
    }

    return {
      clusterId: registerResult.body.clusterId,
    };
  }

  private async processMessage(message: Message): Promise<void> {
    if (!message.Body) {
      throw new Error("Message body is empty");
    }

    const job = packer.unpack(message.Body);
    const registration = this.functionRegistry[job.targetFn];

    const acknowledgement = await this.client.acknowledgeJob({
      headers: {
        "x-sentinel-no-mask": "1",
      },
      params: { jobId: job.id },
    });

    if (acknowledgement.status !== 204) {
      log("Failed to acknowledge job", {
        jobId: job.id,
        body: acknowledgement.body,
      });
    }

    log("Executing job", {
      id: job.id,
      targetFn: job.targetFn,
      registered: !!registration,
    });

    const onComplete = async (result: Result) => {
      log("Persisting job result", {
        id: job.id,
        targetFn: job.targetFn,
        resultType: result.type,
        functionExecutionTime: result.functionExecutionTime,
      });

      const contentAndBlobs = extractBlobs(result.content);

      const persistResult = this.client
        .createResult({
          headers: {
            "x-sentinel-unmask-keys": "resultType,functionExecutionTime",
          },
          body: {
            result: packer.pack(contentAndBlobs.content),
            resultType: result.type,
            functionExecutionTime: result.functionExecutionTime,
          },
          params: {
            jobId: job.id,
          },
        })
        .then(async (res) => {
          if (res.status === 204) {
            log("Completed job", job.id, job.targetFn);
          } else {
            throw new InferableError(`Failed to persist job: ${res.status}`, {
              jobId: job.id,
              body: res.body,
            });
          }
        });

      const persistBlobs = contentAndBlobs.blobs.map((blob) =>
        this.client.createBlob({
          headers: {
            "x-sentinel-no-mask": "1",
          },
          params: {
            jobId: job.id,
          },
          body: blob,
        }),
      );

      await Promise.all([persistResult, ...persistBlobs]);
    };

    if (!registration) {
      const error = new InferableError(
        `Function was not registered. name='${job.targetFn}'`,
      );

      await onComplete({
        type: "rejection",
        content: serializeError(error),
        functionExecutionTime: 0,
      });
    } else {
      const args: Parameters<FunctionRegistration["func"]> = packer.unpack(
        job.targetArgs,
      );

      log("Executing fn", {
        id: job.id,
        targetFn: job.targetFn,
        registeredFn: registration.func,
        args,
      });

      if (typeof args !== "object" || Array.isArray(args) || args === null) {
        log(
          "Function was called with invalid invalid format. Expected an object.",
          {
            function: job.targetFn,
            service: this.service.name,
          },
        );

        return onComplete({
          type: "rejection",
          content: serializeError(
            new Error(
              "Function was called with invalid invalid format. Expected an object.",
            ),
          ),
          functionExecutionTime: 0,
        });
      }

      try {
        registration.schema.input.parse(args);
      } catch (e: unknown) {
        if (e instanceof z.ZodError) {
          e.errors.forEach((error) => {
            log("Function input does not match schema", {
              function: job.targetFn,
              path: error.path,
              error: error.message,
            });
          });
        }

        return onComplete({
          type: "rejection",
          content: serializeError(e),
          functionExecutionTime: 0,
        });
      }

      const result = await executeFn(
        registration.func,
        [args],
        registration.authenticate,
        job.authContext,
      );

      await onComplete(result);
    }
  }

  async start() {
    log("Starting polling agent", { service: this.service });
    return this.registerMachine();
  }

  async stop(): Promise<void> {
    log("Quitting polling agent", { service: this.service });

    if (!this.consumer) {
      throw new Error("Consumer is not running");
    }

    this.consumer.stop({ abort: true });

    await new Promise<void>((resolve) => {
      const check = () => {
        const consumerStatus = this.consumer?.status;
        log("Consumer status", consumerStatus);

        if (!consumerStatus?.isPolling) {
          resolve();
        } else {
          setTimeout(check, 100);
        }
      };

      check();
    });

    this.consumer?.removeAllListeners();

    this.exitHandler();
  }

  public get serviceName(): string {
    return this.service.name;
  }

  public get polling(): boolean {
    return this.consumer?.status.isRunning ?? false;
  }
}
