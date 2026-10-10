"""Render face.png: the woman's portrait that surfaces in this face's rain.

Procedural and stylised, no one's likeness: a head sculpted as a height
field (an egg-shaped skull plus soft bumps and hollows for brow, eyes,
cheekbones, nose, lips, and chin), lit from the upper left like Rain's own
portrait, framed by long hair, on black. The rain reads it as luminance, so
only the broad light and shadow matter. Re-run after changing a number:

    python3 face.py
"""
import numpy as np
from PIL import Image, ImageFilter

W, H = 1024, 1536
y, x = np.mgrid[0:H, 0:W].astype(np.float32)
# face coordinates: origin between the eyes, unit = half the face width
u = (x - 512) / 205.0
v = (y - 640) / 205.0


def g(cx, cy, sx, sy, a):
    """A soft bump (a > 0) or hollow (a < 0)."""
    return a * np.exp(-(((u - cx) / sx) ** 2 + ((v - cy) / sy) ** 2))


# the head: an egg, wide at the cheekbones, narrowing to a small chin
half_w = np.where(v < 0.4, 1.0 - 0.06 * np.clip(-v - 0.8, 0, None),
                  1.0 - 0.36 * (np.clip(v - 0.4, 0, None) / 1.2) ** 1.6)
r2 = (u / half_w) ** 2 + ((v + 0.05) / 1.6) ** 2
inside = r2 < 1
z = np.sqrt(np.clip(1 - r2, 0, None)) * 1.1
z += g(-0.42, -0.50, 0.30, 0.10, 0.10) + g(0.42, -0.50, 0.30, 0.10, 0.10)   # brow
z += g(-0.42, -0.18, 0.28, 0.17, -0.30) + g(0.42, -0.18, 0.28, 0.17, -0.30)  # eye sockets
z += g(-0.62, 0.38, 0.30, 0.22, 0.14) + g(0.62, 0.38, 0.30, 0.22, 0.14)     # cheekbones
z += g(0, 0.2, 0.09, 0.42, 0.30) + g(0, 0.62, 0.13, 0.10, 0.10)            # nose, tip
z += g(-0.15, 0.70, 0.07, 0.05, -0.06) + g(0.15, 0.70, 0.07, 0.05, -0.06)   # nostrils
z += g(0, 0.90, 0.34, 0.06, 0.10) + g(0, 1.02, 0.30, 0.08, 0.12)            # lips
z += g(0, 0.96, 0.36, 0.022, -0.08)                                         # lip line
z += g(0, 1.30, 0.24, 0.12, 0.08)                                           # chin
z = np.where(inside, z, 0).astype(np.float32)

# Lambert light from the upper left and in front, plus a soft sheen
gy, gx = np.gradient(z * 205.0 / 1.0)
n = np.stack([-gx / 205.0 * 4, -gy / 205.0 * 4, np.ones_like(z)])
n /= np.linalg.norm(n, axis=0)
L = np.array([-0.62, -0.50, 0.60]); L /= np.linalg.norm(L)
lam = np.clip((n * L[:, None, None]).sum(0), 0, 1)
spec = np.clip((n * np.array([-0.3, -0.3, 0.9])[:, None, None]).sum(0), 0, 1) ** 24
skin = (0.03 + 1.5 * lam ** 1.8 + 0.3 * spec) * inside
# fall-off toward the face's edge, so it melts into the dark
skin *= np.clip(1 - r2, 0, 1) ** 0.25

# eyes: dark almonds with lashes and a catch-light; brows
def almond(cx, cy, w, h):
    return np.clip(1 - ((u - cx) / w) ** 2 - ((v - cy) / (h * (1 - 0.3 * np.sign(v - cy)))) ** 2, 0, 1)


for s in (-1, 1):
    eye = almond(0.42 * s, -0.17, 0.23, 0.085)
    skin = skin * (1 - 0.97 * (eye > 0))
    lash = np.exp(-(((u - 0.42 * s) / 0.25) ** 2) - ((v + 0.215 - 0.6 * (u - 0.42 * s) ** 2) / 0.022) ** 2)
    skin *= 1 - 0.85 * lash
    skin = np.maximum(skin, 0.9 * np.exp(-(((u - 0.40 * s + 0.03) / 0.025) ** 2 + ((v + 0.19) / 0.025) ** 2)))
    brow = np.exp(-(((u - 0.45 * s) / 0.26) ** 4) - ((v + 0.50 - 0.45 * (u - 0.50 * s) ** 2) / 0.055) ** 2)
    skin *= 1 - 0.9 * brow
# lips a touch darker than the skin, the lower one catching light
skin *= 1 - 0.45 * np.exp(-((u / 0.33) ** 2) - ((v - 0.94) / 0.09) ** 2)
skin *= 1 - 0.8 * np.exp(-((u / 0.3) ** 2) - ((v - 0.96) / 0.025) ** 2)   # the parting
skin *= 1 - 0.6 * np.exp(-((u / 0.2) ** 2) - ((v - 0.73) / 0.04) ** 2)    # under the nose

# neck and shoulders
neck = (np.abs(u) < 0.5 + 0.1 * np.clip(v - 2.6, 0, None)) & (v > 1.1) & (v < 3.0)
neck_l = np.clip(0.45 - 0.38 * (u + 0.42) / 0.84, 0.08, 1) * np.clip((v - 1.45) / 0.6, 0.15, 1)
sh = ((u / 2.1) ** 2 + ((v - 3.6) / 1.3) ** 2) < 1
sh_l = np.clip(0.22 - 0.1 * u - 0.08 * (v - 3.2), 0.02, 1)
body = np.where(sh, sh_l, 0) * np.clip((v - 2.2) / 0.5, 0, 1)
body = np.where(neck & ~inside, neck_l, body)

# hair: a mass around the head falling past the shoulders, with strands,
# and a side-swept fringe across the forehead
rng = np.random.default_rng(3)
strands = np.array(Image.fromarray((rng.random((H // 4, W // 2)) * 255).astype(np.uint8))
                   .resize((W, H)).filter(ImageFilter.GaussianBlur((1, 22))), np.float32) / 255
hair_w = 1.32 + 0.08 * np.clip(v, 0, None) - 0.05 * np.clip(v - 2.4, 0, None) * 3
hair = ((u / hair_w) ** 2 + ((v + 0.25) / 2.05) ** 2 < 1) | ((np.abs(u) < hair_w) & (v > 0) & (v < 2.95 + 0.18 * np.sin(u * 6.5) - 0.2 * (u / hair_w) ** 4))
# a side-swept fringe: the part high on the right, sweeping down to the left temple
fringe = (v < -0.66 - 0.34 * u) & inside
hair_l = np.clip(0.26 - 0.12 * u - 0.05 * v, 0.03, 0.36) * (0.45 + 0.9 * strands)
img = np.where(hair & ~inside, hair_l, 0)
img = np.where(neck & ~inside, neck_l, img)
img = np.where(inside & ~fringe, skin, img)
img = np.where(inside & fringe, hair_l * 1.15, img)
img = np.where(img == 0, body, img)

# soften, add a vignette, and save
out = Image.fromarray((np.clip(img, 0, 1) * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(2.2))
vig = np.clip(1.25 - np.hypot((x - 512) / 620, (y - 760) / 900), 0, 1)
out = Image.fromarray((np.array(out, np.float32) * vig).astype(np.uint8))
out.save(__file__.rsplit("/", 1)[0] + "/face.png" if "/" in __file__ else "face.png")
