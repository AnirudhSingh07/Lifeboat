/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@lifeboat/sdk", "@lifeboat/pq-signer"],
  webpack: (config, { webpack }) => {
    // wagmi's connectors barrel transitively pulls @coinbase/cdp-sdk, whose x402 payment
    // feature imports optional @x402/* modules we never use. Ignore that whole namespace.
    config.plugins.push(
      new webpack.IgnorePlugin({
        resourceRegExp: /^(@x402(\/|$)|@react-native-async-storage\/async-storage$|pino-pretty$)/,
      }),
    );
    // keep optional native/ws deps from breaking the browser bundle
    config.resolve = config.resolve || {};
    config.resolve.fallback = {
      ...(config.resolve.fallback || {}),
      bufferutil: false,
      "utf-8-validate": false,
    };
    return config;
  },
};

export default nextConfig;
