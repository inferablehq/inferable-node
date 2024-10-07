export class InferableError extends Error {
  static UNAUTHORISED =
    "Invalid API Key or API Secret. Make sure you are using the correct API Secret.";

  static UNKNOWN_ENCRYPTION_KEY =
    "Encountered an encrypted message with an unknown encryption key. Make sure you are providing all encryption keys to the client.";

  static INVALID_DATA_TYPE =
    "Serialization process encountered an invalid data type. The data can not be safely serialized. See: https://docs.inferable.dev/advanced/arguments-and-return-values/";

  static JOB_AUTHCONTEXT_INVALID =
    "Function requires authentication but no auth context was provided.";

  private meta?: { [key: string]: unknown };

  constructor(message: string, meta?: { [key: string]: unknown }) {
    super(message);
    this.name = "InferableError";
    this.meta = meta;
  }
}
