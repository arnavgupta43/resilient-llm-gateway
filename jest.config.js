/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: ".",
  testMatch: ["<rootDir>/tests/**/*.test.ts"],
  clearMocks: true,
  setupFilesAfterEnv: ["<rootDir>/tests/setup/jest.setup.ts"],
};
