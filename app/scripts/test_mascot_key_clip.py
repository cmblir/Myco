"""The keyer's cut-prop fade (python3 -m pytest app/scripts).

A light prop that drops into a take from above its picture is held back while
the take's top edge cuts it, then fades in whole. The cap and body are never
touched: a cap that reaches the edge keeps its alpha, so the strip test
(src/lib/notchMascot.test.ts) still fails it, and its rim light stays.
"""

import importlib.util
from pathlib import Path

import numpy as np
import pytest

_spec = importlib.util.spec_from_file_location("keyer", Path(__file__).with_name("mascot-key-clip.py"))
keyer = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(keyer)

ORB = (240, 225, 250)
CAP = (60, 50, 70)
RIM = (150, 135, 170)  # a cap's rim light: luma ~140, like celebrate's apex


def _disc(f: np.ndarray, rgb: tuple[int, int, int], cy: int, r: int = 20, rim: int = 0) -> np.ndarray:
    """`f` with an opaque disc of radius `r` at (84, cy), its outer `rim` px lit."""
    f = f.copy()
    yy, xx = np.mgrid[:168, :168]
    d2 = (xx - 84) ** 2 + (yy - cy) ** 2
    f[d2 < r**2] = (*rgb, 255)
    if rim:
        f[(d2 < r**2) & (d2 >= (r - rim) ** 2)] = (*RIM, 255)
    return f


def _body() -> np.ndarray:
    """A frame holding only the character's dark body, low in the frame."""
    return _disc(np.zeros((168, 168, 4), np.uint8), CAP, cy=130, r=30)


def test_a_light_orb_cut_by_the_top_edge_is_held_back_then_fades_in_whole():
    body = _body()
    take = [body, *(_disc(body, ORB, cy) for cy in (2, 12, 40, 50, 60, 70, 80))]
    out = keyer.fade_in_cut_props(take)
    assert len(out) == len(take)
    # While the edge cuts it, the frame before it dropped in holds.
    assert (out[1] == body).all() and (out[2] == body).all()
    # Then the whole disc fades in, a little more each frame, and plays on.
    orb = [int(f[50, 84, 3]) for f in out[3:6]]
    assert 0 < orb[0] < orb[1] < orb[2] < 255
    assert (out[6] == take[6]).all() and (out[7] == take[7]).all()
    # The body under it never changes.
    for f in out:
        assert (f[110:, :, 3] == body[110:, :, 3]).all()
    # Nothing left on the edge for the strip test to fail.
    assert max(int(f[0, :, 3].max()) for f in out) == 0


def test_a_dark_cap_with_a_light_rim_that_reaches_the_edge_keeps_its_alpha():
    # Cut through, and only grazing the edge with its rim: either way it is the
    # cap, and the strip test must still see it there.
    for cy in (4, 19):
        take = [_body(), _disc(_body(), CAP, cy, rim=3)]
        out = keyer.fade_in_cut_props(take)
        assert all((a == b).all() for a, b in zip(out, take)), cy


def test_frames_with_nothing_cut_are_unchanged():
    take = [_body(), _disc(_body(), ORB, cy=84)]
    assert all((a == b).all() for a, b in zip(keyer.fade_in_cut_props(take), take))


@pytest.mark.parametrize("coverage", [0.16, 0.2, 0.5, 0.75, 1.0])
def test_matte_cleanup_does_not_amplify_a_composited_edge_colour(coverage):
    plate = np.array([0, 255, 0], np.float32)
    foreground = np.array([40, 40, 40], np.float32)
    frame = np.broadcast_to(plate, (32, 32, 3)).copy()
    frame[16, 16] = coverage * foreground + (1 - coverage) * plate

    keyed, _ = keyer.key_frame(frame)

    # Tightening the matte may lower coverage, but must not brighten the RGB
    # recovered from the original green-plate composite.
    np.testing.assert_allclose(keyed[16, 16, :3], foreground, atol=1)
    assert keyed[16, 16, 3] == round((coverage - 0.14) / 0.86 * 255)
    assert (keyed[8, 8] == 0).all()
