import assert from "assert";
import { setupServer } from "msw/node";
import { z } from "zod";
import { createApiClient } from "./create-client";
import { Inferable } from "./Inferable";
import { bypass, http, HttpResponse, passthrough } from "msw";
import { TEST_CLUSTER_ID, TEST_ENDPOINT, TEST_SECRET } from "./tests/utils";

const testService = () => {
  const inferable = new Inferable({
    apiSecret: TEST_SECRET,
    endpoint: TEST_ENDPOINT,
  });

  const service = inferable.service({
    name: `echoService${Math.random().toString(36).substring(2, 15)}`,
  });

  service.register({
    name: "echo",
    func: async (input: { text: string }) => {
      return { echo: input.text };
    },
    schema: {
      input: z.object({
        text: z.string(),
      }),
    },
  });

  service.register({
    name: "sqrt",
    func: async (input: { number: number }) => {
      if (input.number < 0) {
        throw new Error("Cannot calculate square root of a negative number");
      }
      return { result: Math.sqrt(input.number) };
    },
    schema: {
      input: z.object({
        number: z.number(),
      }),
    },
  });

  const client = createApiClient({
    baseUrl: TEST_ENDPOINT,
    machineId: `machine-for-${service.definition.name}`,
  });

  return { service, client };
};

describe("PollingAgent", () => {
  it("should be able run multiple functions in parallel", async () => {
    const { service, client } = testService();

    await service.start();

    const results = await Promise.all(
      Array.from({ length: 10 }).map(async (_, i) => {
        return client.executeJobSync({
          headers: {
            authorization: `Bearer ${TEST_SECRET}`,
          },
          params: {
            clusterId: TEST_CLUSTER_ID,
          },
          body: {
            function: "echo",
            service: service.definition.name,
            input: { text: i.toString() },
          },
        });
      }),
    );

    expect(results.length).toEqual(10);

    await service.stop();
  });

  it("should be able to recover from transient SQS connection errors", async () => {
    let attempts = 0;

    const server = setupServer(
      http.all("*://*.amazonaws.com/*", async ({ request }) => {
        if (attempts < 3) {
          attempts++;
          return new HttpResponse(null, { status: 500 });
        }
        return fetch(bypass(request));
      }),
      http.all("*", async () => {
        return passthrough();
      }),
    );

    const { service, client } = testService();

    server.listen();

    await service.start();

    const result = await client.executeJobSync({
      headers: {
        authorization: `Bearer ${TEST_SECRET}`,
      },
      params: {
        clusterId: TEST_CLUSTER_ID,
      },
      body: {
        function: "echo",
        service: service.definition.name,
        input: {
          text: "foo",
        },
      },
    });

    expect(result.status).toEqual(200);
    assert(result.status === 200);
    expect(result.body.result).toEqual({ echo: "foo" });

    server.close();
  });

  it("should be able to recover from credential expiry", async () => {
    let sentExpiredCredentials = false;

    let requestCount = 0;

    const server = setupServer(
      http.post(`${TEST_ENDPOINT}/machines`, async ({ request }) => {
        requestCount++;

        if (!sentExpiredCredentials) {
          const response = await fetch(bypass(request));
          const data = await response.json();

          sentExpiredCredentials = true;

          return HttpResponse.json({
            ...data,
            credentials: {
              ...data.credentials,
              sessionToken: "nope",
            },
            expiration: new Date(),
          });
        } else {
          return passthrough();
        }
      }),
      http.all("*", async () => {
        return passthrough();
      }),
    );

    const { service, client } = testService();

    server.listen();

    await service.start();

    const result = await client.executeJobSync({
      headers: {
        authorization: `Bearer ${TEST_SECRET}`,
      },
      params: {
        clusterId: TEST_CLUSTER_ID,
      },
      body: {
        function: "echo",
        service: service.definition.name,
        input: {
          text: "foo",
        },
      },
    });

    expect(result.status).toEqual(200);
    assert(result.status === 200);
    expect(result.body.result).toEqual({ echo: "foo" });
    expect(requestCount).toEqual(2);

    server.close();
  });
});
