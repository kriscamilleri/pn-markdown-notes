import { describe, expect, it } from "vitest";
import { rewriteCanonicalImageDestinations } from "../../markdownImageRewriter.js";

const sourceImage = "11111111-1111-4111-8111-111111111111";
const destinationImage = "22222222-2222-4222-8222-222222222222";
const sourceSpace = "33333333-3333-4333-8333-333333333333";
const destinationSpace = "44444444-4444-4444-8444-444444444444";
const user = "55555555-5555-4555-8555-555555555555";

describe("rewriteCanonicalImageDestinations", () => {
  it("rewrites inline, angle, and referenced canonical image destinations only", () => {
    const sourceUrl = `/images/${sourceImage}?space=${sourceSpace}`;
    const markdown = [
      `![inline](${sourceUrl} "title")`,
      `![angle](<${sourceUrl}>)`,
      "![reference][hero]",
      `[hero]: ${sourceUrl} 'caption'`,
      `[ordinary](${sourceUrl})`,
      `<img src="${sourceUrl}">`,
    ].join("\n");

    const result = rewriteCanonicalImageDestinations(markdown, {
      sourceDbKey: `space:${sourceSpace}`,
      destinationDbKey: `space:${destinationSpace}`,
      imageMap: { [sourceImage]: destinationImage },
    });
    const expectedUrl = `/images/${destinationImage}?space=${destinationSpace}`;

    expect(result.content).toContain(`![inline](${expectedUrl} "title")`);
    expect(result.content).toContain(`![angle](<${expectedUrl}>)`);
    expect(result.content).toContain(`[hero]: ${expectedUrl} 'caption'`);
    expect(result.content).toContain(`[ordinary](${sourceUrl})`);
    expect(result.content).toContain(`<img src="${sourceUrl}">`);
    expect(result.sourceImageIds).toEqual([sourceImage]);
  });

  it("preserves code, external, malformed, and noncanonical query destinations byte-for-byte", () => {
    const canonical = `/images/${sourceImage}`;
    const markdown = [
      `\`![inline](${canonical})\``,
      "```md",
      `![fenced](${canonical})`,
      "```",
      `    ![indented](${canonical})`,
      `![external](https://example.test${canonical})`,
      `![protocol-relative](//example.test${canonical})`,
      `![query](${canonical}?token=secret)`,
      `\\![escaped](${canonical})`,
      `![malformed](/images/not-a-uuid)`,
    ].join("\n");

    const result = rewriteCanonicalImageDestinations(markdown, {
      sourceDbKey: `user:${user}`,
      destinationDbKey: `space:${destinationSpace}`,
      imageMap: { [sourceImage]: destinationImage },
    });

    expect(result.content).toBe(markdown);
    expect(result.sourceImageIds).toEqual([]);
    expect(result.noncanonicalImageIds).toEqual([sourceImage]);
  });

  it("preserves a canonical missing image and reports it", () => {
    const markdown = `before ![missing](/images/${sourceImage}) after`;
    const result = rewriteCanonicalImageDestinations(markdown, {
      sourceDbKey: `user:${user}`,
      destinationDbKey: `space:${destinationSpace}`,
      imageMap: {},
    });

    expect(result.content).toBe(markdown);
    expect(result.sourceImageIds).toEqual([sourceImage]);
    expect(result.missingImageIds).toEqual([sourceImage]);
  });

  it("skips Markdown-looking content inside raw HTML blocks", () => {
    const canonical = `/images/${sourceImage}`;
    const markdown = [
      "<div>",
      `![not-markdown](${canonical})`,
      "</div>",
      "",
      `![markdown](${canonical})`,
    ].join("\n");
    const result = rewriteCanonicalImageDestinations(markdown, {
      sourceDbKey: `user:${user}`,
      destinationDbKey: `space:${destinationSpace}`,
      imageMap: { [sourceImage]: destinationImage },
    });
    expect(result.content).toContain(`![not-markdown](${canonical})`);
    expect(result.content).toContain(
      `![markdown](/images/${destinationImage}?space=${destinationSpace})`,
    );
  });
});
