import {LeverService} from "../../src/lever/lever.service"
import {LeverProvider, LEVER_PROVIDER_TOKEN} from "../../src/lever/lever.interface"
import {Test, TestingModule} from "@nestjs/testing"
import * as TE from "fp-ts/TaskEither"

describe("LeverService", () => {
  let service: LeverService
  let mockProvider: jest.Mocked<LeverProvider>

  beforeEach(async () => {
    mockProvider = {
      isLeverActive: jest.fn()
    }

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LeverService,
        {
          provide: LEVER_PROVIDER_TOKEN,
          useValue: mockProvider
        }
      ]
    }).compile()

    service = module.get<LeverService>(LeverService)
  })

  describe("isLeverActive", () => {
    it("should return the value from provider when successful", async () => {
      // Given
      mockProvider.isLeverActive.mockReturnValue(TE.right(true))

      // When
      const result = await service.isLeverActive("read_only_mode")()

      // Except
      expect(result).toBe(true)
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockProvider.isLeverActive).toHaveBeenCalledWith("read_only_mode", false, undefined)
    })

    it("should fallback to default value when provider fails (fail-open)", async () => {
      // Given
      mockProvider.isLeverActive.mockReturnValue(TE.left("lever_provider_error"))

      // When
      const result = await service.isLeverActive("read_only_mode")()

      // Except
      expect(result).toBe(false) // default for read_only_mode is false
    })
  })
})
