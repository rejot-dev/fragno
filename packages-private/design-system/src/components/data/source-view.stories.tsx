import { SourceView } from "./source-view";

export default { title: "Data/Source view" };

export function Script() {
  return (
    <div className="max-w-2xl bg-[var(--bo-panel)] p-4">
      <SourceView
        label="hello.js"
        source={'export {};\nconsole.log("Hello from your JavaScript file!");\n'}
      />
    </div>
  );
}

export function LongLinesWrap() {
  return (
    <div className="max-w-md bg-[var(--bo-panel)] p-4">
      <SourceView
        label="data.json"
        source={Array.from(
          { length: 120 },
          (_, index) =>
            `{"index": ${index}, "path": "/workspace/src/very/deep/module/path/file-${index}.ts"}`,
        ).join("\n")}
      />
    </div>
  );
}
