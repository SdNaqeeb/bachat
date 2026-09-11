/**
 * A one-value slider, built here rather than pulled in as a dependency.
 *
 * The app needs exactly one of these — the discount threshold in Settings — and
 * the community slider ships a native module, a second styling vocabulary and
 * no way to snap to the 5% steps this control wants. Thirty lines of
 * Reanimated plus the gesture handler already in the bundle is the cheaper
 * answer.
 *
 * The thumb has two sources of truth and they never overlap: while a drag is in
 * flight the UI thread owns the position, and the rest of the time the `value`
 * prop does. That is why there is no effect syncing one into the other — each
 * animated style picks whichever is currently in charge, which keeps the drag at
 * sixty frames without letting a programmatic change (a reset) drift out of
 * sync.
 *
 * `onChange` is called on the JS thread only when the snapped step actually
 * changes, so dragging from 20% to 80% fires twelve updates rather than four
 * hundred. Tapping anywhere on the track jumps there, because a 60%-to-35%
 * change should not require a drag.
 */

import { useCallback, useState } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';

import { elevation, palette, radius } from '@/theme';

const TRACK_HEIGHT = 6;
const THUMB = 26;

export type SliderProps = {
  value: number;
  min: number;
  max: number;
  /** Snap increment. The threshold slider steps in whole percentage points. */
  step: number;
  onChange: (next: number) => void;
  /** Fill and thumb colour. Pass `useMode().accent.accent`. */
  accent?: string;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
};

export function Slider({
  value,
  min,
  max,
  step,
  onChange,
  accent = palette.accent,
  accessibilityLabel,
  style,
}: SliderProps) {
  const [width, setWidth] = useState(0);
  const usable = Math.max(0, width - THUMB);
  const span = Math.max(step, max - min);
  /** Where the committed value sits, 0..1. The resting source of truth. */
  const settled = Math.min(1, Math.max(0, (value - min) / span));

  const dragging = useSharedValue(false);
  const dragged = useSharedValue(settled);

  const emit = useCallback(
    (fraction: number) => {
      const raw = min + fraction * span;
      const snapped = Math.round(raw / step) * step;
      const clamped = Math.min(max, Math.max(min, Number(snapped.toFixed(4))));
      if (clamped !== value) onChange(clamped);
    },
    [min, max, span, step, value, onChange]
  );

  // A plain worklet, not a `useCallback`: listing `dragged` as a dependency is
  // what makes the compiler treat it as read-only, and this is the one place
  // that has to write it.
  const seek = (x: number) => {
    'worklet';
    const fraction = usable <= 0 ? 0 : Math.min(1, Math.max(0, (x - THUMB / 2) / usable));
    dragged.value = fraction;
    runOnJS(emit)(fraction);
  };

  const pan = Gesture.Pan()
    .minDistance(0)
    .onBegin((event) => {
      dragging.value = true;
      seek(event.x);
    })
    .onUpdate((event) => seek(event.x))
    .onFinalize(() => {
      dragging.value = false;
    });

  const tap = Gesture.Tap().onEnd((event) => seek(event.x));
  const gesture = Gesture.Simultaneous(pan, tap);

  // Both styles derive the same offset rather than sharing a derived value:
  // a `useDerivedValue` here would make the shared values read-only to the
  // gesture handlers that have to write them.
  const thumbStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: (dragging.value ? dragged.value : settled) * usable }],
  }));
  const fillStyle = useAnimatedStyle(() => ({
    width: (dragging.value ? dragged.value : settled) * usable + THUMB / 2,
  }));

  return (
    <GestureDetector gesture={gesture}>
      <View
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={accessibilityLabel}
        accessibilityValue={{ min, max, now: value }}
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
        style={[styles.root, style]}
      >
        <View style={styles.track} />
        <Animated.View style={[styles.fill, { backgroundColor: accent }, fillStyle]} />
        <Animated.View
          style={[styles.thumb, elevation.thumb, { borderColor: accent }, thumbStyle]}
        />
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  root: {
    height: THUMB + 12,
    justifyContent: 'center',
  },
  track: {
    height: TRACK_HEIGHT,
    borderRadius: radius.pill,
    backgroundColor: palette.surfacePressed,
    marginHorizontal: THUMB / 2,
  },
  fill: {
    position: 'absolute',
    left: 0,
    height: TRACK_HEIGHT,
    borderRadius: radius.pill,
  },
  thumb: {
    position: 'absolute',
    left: 0,
    width: THUMB,
    height: THUMB,
    borderRadius: radius.pill,
    backgroundColor: palette.surface,
    borderWidth: 2.5,
  },
});
