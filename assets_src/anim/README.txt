Drop Mixamo clips here (mixamo.com -> pick the character -> animation -> Download: Format FBX Binary, Skin "Without Skin", 30 fps).
The file stem becomes the clip name the game matches on (src/ai/Bot.js RIG.clips), e.g.:
  Rifle Idle.fbx            -> idle        Rifle Walk.fbx        -> walk        Rifle Run.fbx  -> run
  Crouch Rifle Idle.fbx     -> crouchIdle  Crouch Rifle Walk.fbx -> crouchWalk
  Rifle Aiming Idle.fbx     -> aim         Death From Front.fbx  -> death
Then rebuild the bot GLBs in Blender:  tools/build_bots_rigged.py  (see its docstring), followed by the WebP pass.
The base character lives in assets_src/characters/ (first .glb/.gltf/.fbx found; Mixamo-compatible skeleton).
