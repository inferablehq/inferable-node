import { z } from "zod";
import { Inferable } from "./Inferable";

describe("Inferable", () => {
  const env = process.env;
  beforeEach(() => {
    delete process.env.INFERABLE_API_SECRET;
  });

  afterEach(() => {
    process.env = { ...env };
  });
  it("should initialize without optional args", () => {
    expect(() => new Inferable({ apiSecret: "test" })).not.toThrow();
  });

  it("should throw if no API secret is provided", () => {
    expect(() => new Inferable()).toThrow();
  });

  it("should initialize with API secret in environment", () => {
    process.env.INFERABLE_API_SECRET = "environment_secret";
    expect(() => new Inferable()).not.toThrow();
    const d = new Inferable();
    expect(d.secretPartial).toBe("envi...");
  });

  it("should register a function properly", async () => {
    const d = new Inferable({
      apiSecret: "fake",
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

    const registry = d.getFunctionRegistry();

    expect(registry.echo).toMatchObject({
      name: "echo",
      description: "echoes the input",
      authenticate: expect.any(Function),
      serviceName: "test",
    });

    if (!registry.echo.authenticate) {
      throw new Error("authenticate is not a function");
    }

    expect(
      registry.echo.authenticate("test", { foo: "test" }),
    ).resolves.toBeUndefined();
  });
});
