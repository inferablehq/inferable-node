import { Inferable } from "../Inferable";
import { initClient } from "@ts-rest/core";
import { contract } from "../contract";

if (
  !process.env.INFERABLE_API_SECRET ||
  !process.env.INFERABLE_API_ENDPOINT ||
  !process.env.INFERABLE_CLUSTER_ID
) {
  throw new Error("Test environment variables not set");
}

export const TEST_SECRET = process.env.INFERABLE_API_SECRET;
export const TEST_ENDPOINT = process.env.INFERABLE_API_ENDPOINT;
export const TEST_CLUSTER_ID = process.env.INFERABLE_CLUSTER_ID;

console.log("Testing with", {
  TEST_ENDPOINT,
  TEST_CLUSTER_ID,
});

export const buildRequest = (body: any) => ({
  params: {
    clusterId: TEST_CLUSTER_ID,
  },
  body,
});

export const client = initClient(contract, {
  baseUrl: TEST_ENDPOINT,
  baseHeaders: {
    "x-machine-id": "inferable-test-run",
    Authorization: `Bearer ${TEST_SECRET}`,
  },
});

export const d = new Inferable({
  apiSecret: TEST_SECRET,
  endpoint: TEST_ENDPOINT,
  jobPollWaitTime: 5000,
});

export const inferableInstance = () =>
  new Inferable({
    apiSecret: TEST_SECRET,
    endpoint: TEST_ENDPOINT,
    jobPollWaitTime: 5000,
  });
