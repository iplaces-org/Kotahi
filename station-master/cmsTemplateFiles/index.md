---js
{
  title: "Flax",
  layout: "home.njk",
  class: "home",
  // Only write /index.html for a station with no articles yet; once there are
  // articles, content/articles/paginated-list.njk owns /index.html. Boolean false
  // (not the string "false") is needed so Eleventy writes nothing.
  eleventyComputed: {
    permalink: (data) =>
      data.articleQuery && data.articleQuery.articles && data.articleQuery.articles.length > 0
        ? false
        : "/index.html",
  },
}
---
