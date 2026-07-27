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
  focus = "Terminal",
  script = "Walk through the init flow.\nEmphasize line 42.",
}
