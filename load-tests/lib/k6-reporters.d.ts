/**
 * Type declarations for remote HTTPS imports used in k6 scripts.
 * 
 * k6 runs scripts directly inside its own JavaScript engine, resolving HTTPS URL imports
 * at runtime. However, the TypeScript compiler (tsc) and IDEs do not natively know how
 * to type check remote HTTPS modules, resulting in compiler error ts(2307).
 * 
 * These ambient module declarations map wildcards for remote CDNs/repositories
 * to untyped (or loosely typed) modules, allowing VS Code and eslint to validate
 * import statements and code without flagging HTTPS imports as missing modules.
 */

declare module "https://raw.githubusercontent.com/benc-uk/k6-reporter/*" {
  export function htmlReport(data: any, options?: any): string;
}

declare module "https://jslib.k6.io/k6-summary/*" {
  export function textSummary(data: any, options?: any): string;
}
