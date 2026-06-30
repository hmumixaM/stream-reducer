import { describe, expect, it } from "vitest";
import { parseFeed } from "./feed";

describe("parseFeed", () => {
  it("parses RSS items with audio enclosures", () => {
    const feed = parseFeed(`
      <rss><channel><title>Show</title>
        <item>
          <title>Episode</title>
          <link>https://example.com/e1</link>
          <guid>e1</guid>
          <pubDate>Fri, 12 Jun 2026 12:00:00 GMT</pubDate>
          <enclosure url="https://cdn.example.com/e1.mp3" type="audio/mpeg" />
        </item>
      </channel></rss>
    `);

    expect(feed.title).toBe("Show");
    expect(feed.entries).toHaveLength(1);
    expect(feed.entries[0]).toMatchObject({
      title: "Episode",
      link: "https://example.com/e1",
      guid: "e1",
      audio: "https://cdn.example.com/e1.mp3",
    });
  });

  it("falls back to the channel image when an episode has none", () => {
    const feed = parseFeed(`
      <rss><channel><title>Show</title>
        <itunes:image href = "https://cdn.example.com/show-cover.jpg" />
        <item>
          <title>No image episode</title>
          <guid>e1</guid>
          <enclosure url="https://cdn.example.com/e1.mp3" type="audio/mpeg" />
        </item>
        <item>
          <title>Own image episode</title>
          <guid>e2</guid>
          <itunes:image href="https://cdn.example.com/e2.jpg" />
          <enclosure url="https://cdn.example.com/e2.mp3" type="audio/mpeg" />
        </item>
      </channel></rss>
    `);

    expect(feed.entries[0].thumbnail).toBe("https://cdn.example.com/show-cover.jpg");
    expect(feed.entries[1].thumbnail).toBe("https://cdn.example.com/e2.jpg");
  });

  it("parses Atom entries such as YouTube feeds", () => {
    const feed = parseFeed(`
      <feed>
        <title>Channel</title>
        <entry>
          <id>yt:video:abc</id>
          <title>Video</title>
          <link rel="alternate" href="https://www.youtube.com/watch?v=abc" />
          <published>2026-06-12T12:00:00Z</published>
        </entry>
      </feed>
    `);

    expect(feed.entries[0]).toMatchObject({
      title: "Video",
      link: "https://www.youtube.com/watch?v=abc",
      guid: "yt:video:abc",
    });
  });
});
