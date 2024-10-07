import { client, buildRequest } from "../utils";
import { animalService } from "./animals";

describe("Errors", () => {
  jest.retryTimes(2);
  beforeAll(async () => {
    await animalService.start();
  }, 10000);

  afterAll(async () => {
    await animalService.stop();
  });

  it("should get the normal error", async () => {
    const result = await client.executeJobSync(
      buildRequest({
        service: "animal",
        function: "getNormalAnimal",
        input: {},
      }),
    );

    expect(result.status).toBe(200);
    expect(result.body).toHaveProperty("resultType", "rejection");
    if (result.status == 200) {
      expect(result.body.result).toMatchObject({
        name: "Error",
        message: "This is a normal error",
      });
    }
  });

  it("should get the custom error", async () => {
    const result = await client.executeJobSync(
      buildRequest({
        service: "animal",
        function: "getCustomAnimal",
        input: {},
      }),
    );

    expect(result.status).toBe(200);
    expect(result.body).toHaveProperty("resultType", "rejection");
    if (result.status == 200) {
      expect(result.body.result).toMatchObject({
        name: "AnimalError",
        message: "This is a custom error",
      });
    }
  });
});
