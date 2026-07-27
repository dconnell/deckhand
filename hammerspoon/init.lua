package.path = package.path .. ";" .. hs.configdir .. "/deckhand/?.lua"

dofile(hs.configdir .. "/deckhand/deckhand.lua").start({
  hubUrl = "ws://127.0.0.1:8765",
})
