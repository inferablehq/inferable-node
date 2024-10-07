const pack = (value: unknown) => {
  return JSON.stringify({ value });
};

const unpack = (value: string) => {
  return JSON.parse(value).value;
};

export const packer = { pack, unpack };
