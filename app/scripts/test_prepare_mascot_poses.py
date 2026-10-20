"""Synthetic green-plate regression for the shipped static-pose preparation path."""

import importlib.util
from pathlib import Path

import numpy as np
import pytest
from PIL import Image


_spec = importlib.util.spec_from_file_location("pose_preparer", Path(__file__).with_name("prepare-mascot-poses.py"))
preparer = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(preparer)

PLATE = np.array([0, 255, 0], np.float32)
CAP = np.array([40, 40, 40], np.float32)


def source_with_edge(sources: Path, coverage: float) -> None:
    pixels = np.broadcast_to(PLATE, (384, 384, 3)).copy()
    pixels[120:265, 120:265] = CAP
    pixels[96:112, 120:265] = coverage * CAP + (1 - coverage) * PLATE
    Image.fromarray(pixels.round().astype(np.uint8), "RGB").save(sources / "attention.png")


@pytest.mark.parametrize("coverage", [0.16, 0.2, 0.5, 0.75, 1.0])
def test_matte_cleanup_does_not_turn_a_dark_composited_edge_into_a_bright_fringe(tmp_path, coverage):
    source_with_edge(tmp_path, coverage)
    destination = tmp_path / "prepared"
    preparer.prepare("attention", tmp_path, destination)
    keyed = np.asarray(Image.open(destination / "attention.png"))

    # Compare what a dark/light surface receives. The preserved 8-bit
    # premultiply round-trip can quantize straight RGB at very low alpha.
    edge = keyed[104, 192]
    alpha = edge[3] / 255
    for background in (np.array([20, 20, 20]), np.array([240, 240, 240])):
        np.testing.assert_allclose(edge[:3] * alpha + background * (1 - alpha),
                                   CAP * alpha + background * (1 - alpha), atol=1)
    assert np.ptp(edge[:3].astype(int)) <= 1
    assert abs(int(keyed[104, 192, 3]) - round((coverage - 0.14) / 0.86 * 255)) <= 1
    np.testing.assert_array_equal(keyed[192, 192], [40, 40, 40, 255])
    np.testing.assert_array_equal(keyed[0, 0], [0, 0, 0, 0])


def test_opaque_purple_underside_rim_and_eyes_remain_exact(tmp_path):
    source_with_edge(tmp_path, 0.5)
    source = np.asarray(Image.open(tmp_path / "attention.png")).copy()
    marks = [(120, 96, 190), (150, 135, 170), (240, 240, 240)]
    for y, rgb in zip((150, 170, 210), marks):
        source[y:y + 12, 170:205] = rgb
    Image.fromarray(source, "RGB").save(tmp_path / "attention.png")
    destination = tmp_path / "prepared"
    preparer.prepare("attention", tmp_path, destination)
    keyed = np.asarray(Image.open(destination / "attention.png"))
    for y, rgb in zip((150, 170, 210), marks):
        np.testing.assert_array_equal(keyed[y + 5, 192], [*rgb, 255])


def test_missing_master_and_non_green_plate_fail_without_writing(tmp_path):
    destination = tmp_path / "prepared"
    with pytest.raises(FileNotFoundError):
        preparer.prepare("attention", tmp_path, destination)
    Image.new("RGB", (384, 384), (40, 40, 40)).save(tmp_path / "attention.png")
    with pytest.raises(ValueError, match="expected the generated green-screen master"):
        preparer.prepare("attention", tmp_path, destination)
    assert not destination.exists()


def test_non_square_master_is_rejected_without_writing(tmp_path):
    source_with_edge(tmp_path, 0.5)
    path = tmp_path / "attention.png"
    Image.open(path).resize((512, 384)).save(path)
    destination = tmp_path / "prepared"
    with pytest.raises(ValueError, match="expected a square green-screen master"):
        preparer.prepare("attention", tmp_path, destination)
    assert not destination.exists()
