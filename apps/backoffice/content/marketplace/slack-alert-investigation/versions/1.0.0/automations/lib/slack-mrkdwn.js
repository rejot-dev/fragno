/** Convert report Markdown to Slack mrkdwn; preserve code, escape Slack control characters. @param {string} markdown */
export function toSlackMrkdwn(markdown) {
  /** @type {string[]} */ const saved = [];
  /** @param {string} value */ const keep = (value) =>
    "\uE000" + (saved.push(value) - 1) + "\uE000";
  /** @param {string} value */ const escape = (value) =>
    value
      .replace(/&(?!(?:amp|lt|gt);)/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  const tick = String.fromCharCode(96);
  let text = markdown.replace(/\r\n?/g, "\n").replace(/\uE000/g, "");
  text = text.replace(
    /^(?:\x60{3,}|~{3,})[^\n]*\n([\s\S]*?)(?:^(?:\x60{3,}|~{3,})[ \t]*$|(?![\s\S]))/gm,
    (_, code) => keep(tick.repeat(3) + "\n" + escape(code).trimEnd() + "\n" + tick.repeat(3)),
  );
  text = text.replace(/\x60([^\x60\n]+)\x60/g, (_, code) => keep(tick + escape(code) + tick));
  text = text.replace(/!?\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)(?:\s+"[^"]*")?\)/g, (_, label, url) =>
    keep("<" + escape(url).replace(/\|/g, "%7C") + "|" + escape(label).replace(/\|/g, "¦") + ">"),
  );
  // Preserve explicit Slack HTTP links, but escape user/channel mentions from report data.
  text = text.replace(/<(https?:\/\/[^>\n]+)>/g, (_, link) => keep("<" + escape(link) + ">"));
  text = escape(text);
  text = text
    .replace(/\*\*([^\n]+?)\*\*/g, "*$1*")
    .replace(/__([^\n]+?)__/g, "*$1*")
    .replace(/~~([^\n]+?)~~/g, "~$1~");
  text = text.replace(
    /^ {0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/gm,
    (_, heading) => "*" + heading.replace(/^\*|\*$/g, "") + "*",
  );
  text = text.replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, "──────────");
  text = text.replace(/^([ \t]*)[-+*][ \t]+/gm, "$1• ");
  // Slack has no Markdown tables: render table rows as readable plain-text lines.
  text = text.replace(
    /^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)+\|?[ \t]*$/gm,
    "",
  );
  text = text.replace(/^[ \t]*\|(.+)\|[ \t]*$/gm, (_, row) =>
    row
      .trim()
      .split(/[ \t]*\|[ \t]*/)
      .join(" — "),
  );
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.replace(/\uE000(\d+)\uE000/g, (_, index) => saved[Number(index)]).trim();
}
