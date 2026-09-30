module.exports = async () => {
  const [{ cloudflareTest }, { defineConfig }] = await Promise.all([
    import('@cloudflare/vitest-plugin'),
    import('vitest/config')
  ]);

  return defineConfig({
    plugins: [
      cloudflareTest({
        wrangler: {
          configPath: './wrangler.vitest.toml'
        },
      })
    ],
    test: {
      include: ['tests/**/*.test.js'],
      testTimeout: 30000,
      hookTimeout: 30000
    }
  });
};
