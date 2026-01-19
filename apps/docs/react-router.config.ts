import type { Config } from "@react-router/dev/config";

export default {
  ssr: true,
  future: {
    v8_viteEnvironmentApi: true,
    v8_middleware: true,
  },
  // TODO(Wilco): This does not work with Cloudflare's vite plugin
  // async prerender({ getStaticPaths }) {
  //   const paths: string[] = [];
  //   const excluded: string[] = ["/api/search"];

  //   for (const path of getStaticPaths()) {
  //     if (!excluded.includes(path)) {
  //       paths.push(path);
  //     }
  //   }

  //   for await (const entry of glob("**/*.mdx", { cwd: "content/docs" })) {
  //     paths.push(getUrl(getSlugs(entry)));
  //   }

  //   return paths;
  // },
} satisfies Config;
