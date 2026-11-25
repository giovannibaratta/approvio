import {Logger} from "@nestjs/common"

/** Records log arguments until Jest restores the spies. */
export function observeLogs(): string[] {
  const messages: string[] = []
  const record = (...args: unknown[]) => {
    messages.push(args.map(String).join(" "))
  }
  jest.spyOn(Logger, "error").mockImplementation(record)
  jest.spyOn(Logger, "warn").mockImplementation(record)
  jest.spyOn(Logger, "log").mockImplementation(record)
  return messages
}
