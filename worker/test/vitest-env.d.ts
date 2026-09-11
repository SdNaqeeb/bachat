/// <reference types="@cloudflare/vitest-pool-workers" />

declare module "*.sql?raw" {
  const content: string;
  export default content;
}
