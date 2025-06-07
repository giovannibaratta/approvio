export function addSecondsToDate(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000)
}

export function removeSecondsFromDate(date: Date, seconds: number): Date {
  return new Date(date.getTime() - seconds * 1000)
}
