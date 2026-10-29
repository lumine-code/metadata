module.exports = {
  version: 1,
  dependencies: ["language-javascript"],
  viewport: { width: 1200, height: 760 },
  async prepare({ open, state }) {
    state.editor = await open("signal.js");
  },
  scenes: [
    {
      id: "document-properties",
      file: "demo.png",
      caption: "Inspect the current document alongside its saved file properties.",
      async run({ state, command }) {
        state.editor.setCursorBufferPosition([7, 0]);
        state.editor.insertText("// Explore the current, unsaved document.\n");
        command("metadata:show");
      },
      ready() {
        const inspector = document.querySelector(".metadata");
        return Boolean(
          inspector &&
          inspector.getAttribute("aria-busy") === "false" &&
          inspector.querySelectorAll(".metadata-section").length > 1,
        );
      },
    },
  ],
};
