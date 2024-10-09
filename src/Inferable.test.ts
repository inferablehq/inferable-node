import { z } from "zod";
import { Inferable } from "./Inferable";
import { TEST_CLUSTER_ID, client, inferableInstance } from "./tests/utils";

const testService = () => {
  const inferable = inferableInstance();

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
    name: "error",
    func: async (_input) => {
      throw new Error("This is an error");
    },
    schema: {
      input: z.object({
        text: z.string(),
      }),
    },
  });

  return service;
};

describe("Inferable", () => {
  const env = process.env;
  beforeEach(() => {
    delete process.env.INFERABLE_API_SECRET;
  });

  afterEach(() => {
    process.env = { ...env };
  });

  it("should initialize without optional args", () => {
    expect(() => new Inferable({ apiKey: "test" })).not.toThrow();
  });

  it("should throw if no API secret is provided", () => {
    expect(() => new Inferable()).toThrow();
  });

  it("should initialize with API secret in environment", () => {
    process.env.INFERABLE_API_SECRET = "environment_secret";
    expect(() => new Inferable()).not.toThrow();
    const d = new Inferable();
    expect(d.keyPartial).toBe("envi...");
  });

  it("should register a function", async () => {
    const d = new Inferable({
      apiKey: "fake",
    });

    const echo = async (param: { foo: string }) => {
      return param.foo;
    };

    const service = d.service({ name: "test" });

    service.register({
      func: echo,
      name: "echo",
      schema: {
        input: z.object({
          foo: z.string(),
        }),
      },
      description: "echoes the input",
      authenticate: (ctx, args) => {
        return args.foo === ctx ? Promise.resolve() : Promise.reject();
      },
    });

    expect(d.registeredFunctions).toEqual(["echo"]);
  });

  it("should list active and inactive services correctly", async () => {
    const d = inferableInstance();

    const service = d.service({ name: "test" });

    const echo = async (param: { foo: string }) => {
      return param.foo;
    };

    service.register({
      func: echo,
      name: "echo",
      schema: {
        input: z.object({
          foo: z.string(),
        }),
      },
      description: "echoes the input",
      authenticate: (ctx, args) => {
        return args.foo === ctx ? Promise.resolve() : Promise.reject();
      },
    });

    expect(d.activeServices).toEqual([]);
    expect(d.inactiveServices).toEqual([]);

    await service.start();

    expect(d.activeServices).toEqual(["test"]);
    expect(d.inactiveServices).toEqual([]);

    await service.stop();

    expect(d.activeServices).toEqual([]);
    expect(d.inactiveServices).toEqual(["test"]);
  });
});

describe("Functions", () => {
  it("should handle successful function calls", async () => {
    const service = testService();

    await service.start();

    const results = await Promise.all(
      Array.from({ length: 10 }).map(async (_, i) => {
        return client.createCall({
          query: {
            waitTime: 20,
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

    results.forEach((result) => {
      expect(result.status).toBe(200);
      if (result.status !== 200) throw new Error("Assertion failed");

      expect(result.body).toEqual(
        expect.objectContaining({
          status: "success",
          resultType: "resolution",
          result: {
            echo: expect.any(String),
          },
        }),
      );
    });

    await service.stop();
  });
});
