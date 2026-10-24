import { describe, expect, it } from "vitest";
import { htmlHasContent } from "./bodies";

/**
 * The blank-body cases come from real mail: a MIME part that exists and says nothing. Each one
 * here is a body that used to render as a tall white frame with no explanation.
 */
describe("htmlHasContent", () => {
  it("reads an empty or whitespace part as nothing", () => {
    expect(htmlHasContent("")).toBe(false);
    expect(htmlHasContent("   \n\t ")).toBe(false);
    expect(htmlHasContent("<html><body></body></html>")).toBe(false);
    expect(htmlHasContent("<div></div><p>&nbsp;</p>")).toBe(false);
    expect(htmlHasContent("<p>&#160;</p><span> </span>")).toBe(false);
  });

  it("reads words, an image or a data-URI logo as content", () => {
    expect(htmlHasContent("<p>Your code is 123456</p>")).toBe(true);
    expect(htmlHasContent('<img src="https://e.example/logo.gif">')).toBe(true);
    expect(htmlHasContent('<img src="data:image/png;base64,iVBOR">')).toBe(true);
  });

  it("does not mistake styling or a script for something to read", () => {
    expect(htmlHasContent("<style>body{color:red}</style>")).toBe(false);
    expect(htmlHasContent("<script>/* nothing */</script><div> </div>")).toBe(false);
    // The words are outside the markup that would otherwise be mistaken for them.
    expect(htmlHasContent("<script>var x=1</script><p>hello</p>")).toBe(true);
  });

  it("ignores an img tag with no source, which paints nothing", () => {
    expect(htmlHasContent("<img><img src=\"\">")).toBe(false);
  });
});
