import type { Config } from "@react-router/dev/config";

function getDocsBuildDirectory(value = process.env.FRAGNO_DOCS_TARGET) {
  if (value === undefined) {
    return "build/app";
  }

  const normalizedValue = value.trim().toLowerCase();

  if (normalizedValue === "all") {
    return "build/app";
  }

  if (normalizedValue === "docs" || normalizedValue === "backoffice") {
    return `build/${normalizedValue}`;
  }

  throw new Error(
    `Invalid FRAGNO_DOCS_TARGET value: ${value}. Expected one of: all, docs, backoffice.`,
  );
}

export default {
  ssr: true,
  buildDirectory: getDocsBuildDirectory(),
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
