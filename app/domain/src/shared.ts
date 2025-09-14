export type Versioned<T> = T & {
  readonly occ: bigint
}
