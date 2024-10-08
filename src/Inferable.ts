import debug from "debug";
import path from "path";
import { z } from "zod";
import zodToJsonSchema from "zod-to-json-schema";
import { createApiClient } from "./create-client";
import { InferableError } from "./errors";
import { FunctionRegistration } from "./types";
import { machineId } from "./machine-id";
import { PollingAgent } from "./polling-agent";
import {
  FunctionConfig,
  FunctionInput,
  FunctionRegistrationInput,
  JsonSchemaInput,
  RegisteredService,
} from "./types";
import {
  isZodType,
  validateDescription,
  validateFunctionName,
  validateFunctionSchema,
  validateServiceName,
} from "./util";

// Custom json formatter
debug.formatters.J = (json) => {
  return JSON.stringify(json, null, 2);
};

export const log = debug("inferable:client");

/**
 * The Inferable client. This is the main entry point for using Inferable.
 *
 * Inferable client exposes two main methods:
 * * `service` - Registers a service with Inferable.
 * * `workflow` - Starts a workflow with Inferable
 *
 * @example Basic usage
 * ```ts
 * // src/service.ts
 *
 * // create a new Inferable instance
 * const d = new Inferable("API_SECRET");
 *
 * const myService = d.service({
 *   name: "my-service",
 * });
 *
 * myService.register("hello", z.object({name: z.string()}), async ({name}: {name: string}) => {
 *  return `Hello ${name}`;
 * })
 *
 * await myService.start();
 *
 * // stop the service on shutdown
 * process.on("beforeExit", async () => {
 *   await myService.stop();
 * });
 *
 * ```
 */
export class Inferable {
  static getMachineId(): string {
    return machineId();
  }

  static getVersion(): string {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require(path.join(__dirname, "..", "package.json")).version;
  }

  private apiSecret: string;
  private endpoint: string;
  private machineId: string;
  private controlPlaneClient: ReturnType<typeof createApiClient>;

  private clusterIdFromPollingAgent: string | null = null;

  private jobPollWaitTime?: number;

  private pollingAgents: PollingAgent[] = [];

  private functionRegistry: { [key: string]: FunctionRegistration } = {};

  /**
   * Initializes a new Inferable instance.
   * @param apiSecret The API Secret for your Inferable cluster. If not provided, it will be read from the `INFERABLE_API_SECRET` environment variable.
   * @param options Additional options for the Inferable client.
   * @param options.endpoint The endpoint for the Inferable cluster. Defaults to https://api.inferable.ai.
   * @param options.jobPollWaitTime The amount of time in milliseconds that the client will maintain a connection to the control-plane when polling for jobs. Defaults to 20000ms. If a job is not received within this time, the client will close the connection and try again.
   *
   * @example
   * ```ts
   * // Basic usage
   * const d = new Inferable({
   *  apiSecret: "API_SECRET",
   * });
   *
   * // OR
   *
   * process.env.INFERABLE_API_SECRET = "API_SECRET";
   * const d = new Inferable();
   *
   *
   * // With encryption
   * const d = new Inferable({
   *  encryptionKeys: [
   *    Buffer.from("abcdefghijklmnopqrstuvwxzy123456"), // current key
   *    Buffer.from("abcdefghijklmnopqrstuvwxzy123old"), // previous key
   *  ],
   * });
   * ```
   */
  constructor(options?: {
    apiSecret?: string;
    endpoint?: string;
    jobPollWaitTime?: number;
  }) {
    if (options?.apiSecret && process.env.INFERABLE_API_SECRET) {
      log(
        "API Secret was provided as an option and environment variable. Constructor argument will be used.",
      );
    }

    const apiSecret = options?.apiSecret || process.env.INFERABLE_API_SECRET;

    if (!apiSecret) {
      throw new InferableError("No API Secret provided.");
    }

    this.apiSecret = apiSecret;

    this.endpoint =
      options?.endpoint ||
      process.env.INFERABLE_API_ENDPOINT ||
      "https://api.inferable.ai";
    this.machineId = machineId();

    const jobPollWaitTime = options?.jobPollWaitTime || 20000;

    if (jobPollWaitTime < 5000) {
      throw new InferableError("jobPollWaitTime must be at least 5000ms");
    }

    if (jobPollWaitTime > 20000) {
      throw new InferableError("jobPollWaitTime must be at most 20000ms");
    }

    this.jobPollWaitTime = options?.jobPollWaitTime;

    log("Initializing control plane client", {
      endpoint: this.endpoint,
      machineId: this.machineId,
    });

    this.controlPlaneClient = createApiClient({
      baseUrl: this.endpoint,
      machineId: this.machineId,
      apiSecret: this.apiSecret,
    });

    setInterval(() => {
      this.controlPlaneClient
        .pingClusterV2({
          headers: {
            "x-sentinel-no-mask": "1",
          },
          body: {
            services: this.activeServices,
          },
        })
        .catch((e) => {
          console.error(
            "Error pinging cluster. Will try again next interval.",
            e,
          );
        });
    }, 10000);
  }

  public get secretPartial(): string {
    return (this.apiSecret || "").substring(0, 4) + "...";
  }

  /**
   * An array containing the name of all services currently polling.
   */
  public get activeServices(): string[] {
    return this.pollingAgents
      .filter((agent) => agent.polling)
      .map((agent) => agent.serviceName);
  }

  /**
   * An array containing the name of all services not currently polling.
   *
   * Note that this will only include services which have been started (`.start()` called).
   */
  public get inactiveServices(): string[] {
    return this.pollingAgents
      .filter((agent) => !agent.polling)
      .map((agent) => agent.serviceName);
  }

  private isCurrentlyPolling(service: string): boolean {
    return this.pollingAgents
      .filter((agent) => agent.serviceName == service)
      .some((agent) => agent.polling);
  }

  private async listen(name: string): Promise<void> {
    if (this.isCurrentlyPolling(name)) {
      throw new InferableError(`Service is already started`, {
        serviceName: name,
      });
    }

    const pollingAgent = new PollingAgent({
      endpoint: this.endpoint,
      machineId: this.machineId,
      apiSecret: this.apiSecret,
      service: {
        name: name,
      },
      ttl: this.jobPollWaitTime,
      exitHandler: () => {
        // TODO: deprecate
      },
      functionRegistry: this.functionRegistry,
    });

    this.pollingAgents.push(pollingAgent);

    const { clusterId } = await pollingAgent.start();

    this.clusterIdFromPollingAgent = clusterId;
  }

  private async stop(): Promise<void> {
    await Promise.all(this.pollingAgents.map((agent) => agent.stop()));

    log("All polling agents quit", {
      count: this.pollingAgents.length,
    });
  }

  private register<T extends z.ZodTypeAny | JsonSchemaInput>({
    name,
    authenticate,
    serviceName,
    func,
    inputSchema,
    config,
    description,
  }: {
    authenticate?: (
      authContext: string,
      args: FunctionInput<T>,
    ) => Promise<void>;
    name: string;
    serviceName: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    func: (input: FunctionInput<T>) => any;
    inputSchema: T;
    config?: FunctionConfig;
    description?: string;
  }) {
    if (this.functionRegistry[name]) {
      throw new InferableError(
        `Function name '${name}' is already registered by another service.`,
      );
    }

    // We accept both Zod types and JSON schema as an input, convert to JSON schema if the input is a Zod type
    const inputJson = (
      isZodType(inputSchema) ? zodToJsonSchema(inputSchema) : inputSchema
    ) as JsonSchemaInput;

    validateFunctionName(name);
    validateDescription(description);

    const schemaErrors = validateFunctionSchema(inputJson);

    if (schemaErrors.length > 0) {
      log(
        `Schema ${serviceName}${name} failed validation: %J with failures %O`,
        inputSchema,
        schemaErrors,
      );
      throw new InferableError(
        `JSON schema was not valid for service '${serviceName}.${name}'. Run with debug logging (DEBUG=inferable:*) for more details.`,
        {
          failures: schemaErrors,
        },
      );
    }

    const registration: FunctionRegistration<T> = {
      name,
      authenticate,
      serviceName,
      func,
      schema: {
        input: inputSchema,
        inputJson: JSON.stringify(inputJson),
      },
      config,
      description,
    };

    if (this.isCurrentlyPolling(registration.serviceName)) {
      throw new InferableError(
        "Functions must be registered before starting the service",
        {
          serviceName: registration.serviceName,
        },
      );
    }

    if (typeof registration.func !== "function") {
      throw new InferableError("func must be a function");
    }

    log(`Registering function`, {
      name: registration.name,
    });

    this.functionRegistry[registration.name] = registration;
  }

  /**
   * Convenience reference to a service with name 'default'.
   * @returns A registered service instance.
   * @see {@link service}
   * @example
   * ```ts
   * const d = new Inferable({apiSecret: "API_SECRET"});
   *
   * d.default.register("hello", z.object({name: z.string()}), async ({name}: {name: string}) => {
   *   return `Hello ${name}`;
   * });
   *
   * // start the service
   * await d.default.start();
   *
   * // stop the service on shutdown
   * process.on("beforeExit", async () => {
   *   await d.default.stop();
   * });
   *
   */
  get default() {
    return this.service({
      name: "default",
    });
  }

  /**
   * Registers a service with Inferable. This will register all functions on the service.
   * @param input The service definition.
   * @returns A registered service instance.
   * @example
   * ```ts
   * const d = new Inferable({apiSecret: "API_SECRET"});
   *
   * const service = d.service({
   *   name: "my-service",
   * });
   *
   * service.register("hello", z.object({name: z.string()}), async ({name}: {name: string}) => {
   *   return `Hello ${name}`;
   * });
   *
   * // start the service
   * await service.start();
   *
   * // stop the service on shutdown
   * process.on("beforeExit", async () => {
   *   await service.stop();
   * });
   * ```
   */
  service<T extends z.ZodTypeAny | JsonSchemaInput>(input: {
    name: string;
    functions?:
      | FunctionRegistrationInput<T>[]
      | Promise<FunctionRegistrationInput<T>[]>;
  }): RegisteredService {
    validateServiceName(input.name);

    const register: RegisteredService["register"] = ({
      name,
      func,
      schema,
      config,
      description,
      authenticate,
    }) => {
      this.register({
        name,
        authenticate,
        serviceName: input.name,
        func,
        inputSchema: schema.input,
        config,
        description,
      });
    };

    return {
      definition: input,
      register,
      start: async () => {
        const functions = await input.functions;
        functions?.forEach(register);

        return this.listen(input.name);
      },
      stop: () => this.stop(),
    };
  }

  getFunctionRegistry() {
    return this.functionRegistry;
  }

  get clusterId(): string | null {
    return this.clusterIdFromPollingAgent;
  }
}
