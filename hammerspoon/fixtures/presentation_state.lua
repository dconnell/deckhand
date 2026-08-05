return {
  type = "presentationState",
  seq = 7,
  slideId = "code-walkthrough",
  layoutId = "left-terminal-right-slide",
  audienceScene = "Left Terminal Right Slide",
  slots = {
    {
      source = "Terminal",
      position = "left",
      rect = { x = 0, y = 0, w = 900, h = 1168 },
    },
    {
      source = "Slide",
      position = "right",
      rect = { x = 900, y = 0, w = 900, h = 1168 },
    },
  },
  windowBindings = {
    Terminal = { app = "iTerm2" },
    Slide = { app = "Safari", titleIncludes = "Deckhand Deck" },
  },
  managedWindowBindings = {
    Terminal = { app = "iTerm2" },
    Slide = { app = "Safari", titleIncludes = "Deckhand Deck" },
    BrowserA = { app = "Google Chrome", titleIncludes = "Deckhand BrowserA", pid = 47213 },
    BrowserB = { app = "Google Chrome", titleIncludes = "Deckhand BrowserB", pid = 47213 },
    Presenter = { app = "Google Chrome", titleIncludes = "Deckhand Presenter" },
  },
  overlays = {
    {
      source = "Presenter",
      rect = { x = 0, y = 1120, w = 1800, h = 48 },
    },
  },
  focus = "Terminal",
  script = "Walk through the init flow.\nEmphasize line 42.",
}
