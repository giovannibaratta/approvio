export enum ResponseBodyStatus {
  OK = "OK",
  MISSING = "MISSING",
  BINARY_DATA = "BINARY_DATA",
  TRUNCATED = "TRUNCATED",
  PROCESSING_FAILED = "PROCESSING_FAILED"
}

export interface HttpResponse {
  status: number
  body?: string
  bodyStatus: ResponseBodyStatus
}
