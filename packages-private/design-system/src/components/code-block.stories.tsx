import { CodeBlock } from "./code-block";

export default { title: "Data/Code block" };

export function Captioned() {
  return (
    <div className="max-w-2xl">
      <CodeBlock
        label="Latest handler result"
        language="javascript"
        code={'return { status: "delivered", attempts: 1 };'}
      />
    </div>
  );
}

export function Uncaptioned() {
  return (
    <div className="max-w-2xl">
      <CodeBlock code={"line one\nline two\n  indented line three"} />
    </div>
  );
}

export function LongLinesScroll() {
  return (
    <div className="max-w-md">
      <CodeBlock
        label="Stack trace"
        code={Array.from(
          { length: 40 },
          (_, index) =>
            `    at handler (/workspace/src/very/deep/module/path/file-${index}.ts:12:7)`,
        ).join("\n")}
      />
    </div>
  );
}
