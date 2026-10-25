import { describe, expect, it } from "vitest";
import { markdownToHtml } from "../../src/mail/markdown";

describe("markdownToHtml (the compose box's formatting)", () => {
  it("keeps the writer's line breaks inside a paragraph", () => {
    expect(markdownToHtml("one\ntwo")).toBe("<p>one<br>two</p>");
  });

  it("splits paragraphs on a blank line", () => {
    expect(markdownToHtml("a\n\nb")).toBe("<p>a</p>\n<p>b</p>");
  });

  it("folds quote lines into one blockquote, reply style", () => {
    expect(markdownToHtml("> wrote this\n> and this")).toBe(
      "<blockquote><p>wrote this<br>and this</p></blockquote>",
    );
  });

  it("groups list items under one bullet list", () => {
    expect(markdownToHtml("- a\n- b")).toBe("<ul><li>a</li><li>b</li></ul>");
  });

  it("carries the inline marks: code, strong, em, https links", () => {
    expect(markdownToHtml("`x` **b** *i* [t](https://e.example)")).toBe(
      '<p><code>x</code> <strong>b</strong> <em>i</em> <a href="https://e.example">t</a></p>',
    );
  });

  it("escapes what looks like markup, so typed text can never become a tag", () => {
    expect(markdownToHtml("<script>alert(1)</script>")).toBe(
      "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>",
    );
  });

  it("does not link an http address — https only, like everywhere else in the app", () => {
    expect(markdownToHtml("[t](http://e.example)")).toBe("<p>[t](http://e.example)</p>");
  });
});

describe("markdownToHtml inline images (B3)", () => {
  it("renders a cid image reference with its alt text", () => {
    expect(markdownToHtml("look: ![a chart](cid:cidfile-abc-1)")).toBe(
      '<p>look: <img src="cid:cidfile-abc-1" alt="a chart"></p>',
    );
  });

  it("does not render a hotlinked image — only the message's own files ride inside", () => {
    // The ! survives as text: markdown's negation, not an image tag.
    expect(markdownToHtml("![x](https://tracker.example/pixel.gif)")).toBe(
      '<p>!<a href="https://tracker.example/pixel.gif">x</a></p>',
    );
  });
});
