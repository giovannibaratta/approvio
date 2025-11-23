const mainSettings = {
  testEnvironment: "node",
  transform: {
    "^.+\\.(t|j)sx?$": ["ts-jest", {}]
  },
  moduleNameMapper: {
    "^@app/(.*)$": "<rootDir>/app/main/src/$1",
    "^@app$": "<rootDir>/app/main/src",
    "@controllers/(.*)": "<rootDir>/app/controllers/src/$1",
    "@controllers": "<rootDir>/app/controllers/src",
    "@domain/(.*)": "<rootDir>/app/domain/src/$1",
    "@domain": "<rootDir>/app/domain/src",
    "@services/(.*)": "<rootDir>/app/services/src/$1",
    "@services": "<rootDir>/app/services/src",
    "@external/(.*)": "<rootDir>/app/external/src/$1",
    "@external": "<rootDir>/app/external/src",
    "@utils/(.*)": "<rootDir>/app/utils/src/$1",
    "@utils": "<rootDir>/app/utils/src",
    "@test/(.*)$": "<rootDir>/app/test/$1",
    "^@prisma/client$": "<rootDir>/generated/prisma/client.ts"
  }
}

const testSettings = {
  coverageDirectory: "<rootDir>/coverage",
  coverageReporters: ["text", "lcov", "html"],
  collectCoverageFrom: [
    "**/*.ts",
    // Source code exclusions
    "!**/testing/**",
    // Artifacts and other exclusions
    "!**/node_modules/**",
    "!**/*.mock.ts",
    "!build/**"
  ],
  modulePathIgnorePatterns: ["<rootDir>/build/"],
  setupFilesAfterEnv: ["<rootDir>/app/utils/src/matchers.ts"],
  transformIgnorePatterns: ["node_modules/(?!(openid-client|oauth4webapi|jose)/)"]
}

module.exports = {
  ...mainSettings,
  ...testSettings
}
