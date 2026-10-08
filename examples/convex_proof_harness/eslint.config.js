import config from "@skiplabs/eslint-config";

export default [
  ...config,
  {
    ignores: ["dist/**", "src/**/*.test.ts"],
  },
];
