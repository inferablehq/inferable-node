import { buildRequest, client } from "../utils";
import { productService } from "./product";

describe("Caching", () => {
  const service = productService();

  beforeAll(async () => {
    await service.start();
  }, 10000);

  afterAll(async () => {
    await service.stop();
  });

  it("should get the cached results when possible", async () => {
    const productId = Math.random().toString();

    const result1 = await client.executeJobSync(
      buildRequest({
        service: service.definition.name,
        function: "getProduct10sCache",
        input: { id: productId, random: "foo" },
      }),
    );

    const result2 = await client.executeJobSync(
      buildRequest({
        service: service.definition.name,
        function: "getProduct10sCache",
        input: { id: productId, random: "bar" },
      }),
    );

    expect(result1.status).toBe(200);
    expect(result1.body).toHaveProperty("resultType", "resolution");

    expect(result1.body).toEqual(result2.body);
  });

  it("should respect cache ttl", async () => {
    const productId = Math.random().toString();

    const result1 = await client.executeJobSync(
      buildRequest({
        service: service.definition.name,
        function: "getProduct1sCache",
        input: { id: productId, random: "foo" },
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 2000)); // wait for cache to expire

    const result2 = await client.executeJobSync(
      buildRequest({
        service: service.definition.name,
        function: "getProduct1sCache",
        input: { id: productId, random: "bar" },
      }),
    );

    expect(result1.status).toBe(200);
    expect(result2.status).toBe(200);
    expect(result1.body).toHaveProperty("resultType", "resolution");
    expect(result2.body).toHaveProperty("resultType", "resolution");

    expect(result1.body).not.toEqual(result2.body);
  });
});
