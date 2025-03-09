const mainSettings = {
  testEnvironment: "node",
  transform: {
    "^.+\\.(t|j)sx?$": [
      "ts-jest",
      {
        // Skip type check
        isolatedModules: true
      }
    ]
  },
  moduleNameMapper: {
    "@app/(.*)": "<rootDir>/app/main/src/$1",
    "@app": "<rootDir>/app/main/src",
    "@controllers/(.*)": "<rootDir>/app/controllers/src/$1",
    "@controllers": "<rootDir>/app/controllers/src",
    "@domain/(.*)": "<rootDir>/app/domain/src/$1",
    "@domain": "<rootDir>/app/domain/src",
    "@services/(.*)": "<rootDir>/app/services/src/$1",
    "@services": "<rootDir>/app/services/src",
    "@external/(.*)": "<rootDir>/app/external/src/$1",
    "@external": "<rootDir>/app/external/src",
    "@api": "<rootDir>/generated/openapi/model/models"
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
  modulePathIgnorePatterns: ["<rootDir>/build/"]
}

module.exports = {
  ...mainSettings,
  ...testSettings
}
