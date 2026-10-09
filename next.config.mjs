// Plain JavaScript on purpose: a next.config.ts is transpiled with the native SWC binary on every start, which the
// Windows installer does not ship (Next.js would try to download it). See tests/start-script.test.ts.
/** @type {import('next').NextConfig} */
const nextConfig = {};
export default nextConfig;
