/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@lifeboat/sdk", "@lifeboat/pq-signer"],
};

export default nextConfig;
