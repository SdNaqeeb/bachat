/**
 * Quick Commerce ⇄ Fashion — the app's signature control (spec §9).
 *
 * Mode gates retailers, categories, the feed and alerts, so the switch has to
 * read as changing the whole app rather than filtering one list. Three things
 * do that work:
 *
 * 1. **A thumb that slides, not a label that swaps.** One shared value drives
 *    the thumb's position, its colour (teal to plum) and both labels' contrast,
 *    with an under-damped spring so it settles like a physical toggle.
 * 2. **The thumb carries the mode's own accent**, the same colour the active
 *    tab and the focused filters take, so the connection between the switch and
 *    the rest of the chrome is visible rather than asserted.
 * 3. **Selection haptic on flip.** It is used dozens of times a day.
 *
 * Both halves are tappable, so the control works as a switch (tap anywhere) and
 * as a segmented picker (tap the one you want). Reduced motion drops the spring
 * and keeps the colour change, which is the part that carries the meaning.
 *
 * Width is measured rather than assumed: the header is squeezed differently on
 * a 5" phone and a tablet, and a hardcoded thumb width would drift.
 */

import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  interpolate,
  interpolateColor,
  useAnimatedStyle,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';

import { PressableScale } from '@/components/ui/pressable-scale';
import { useHaptics } from '@/hooks/use-haptics';
import { useMode } from '@/hooks/use-mode';
import { usePrefs } from '@/hooks/use-prefs';
import { MODES, MODE_SHORT_LABEL, type Mode } from '@/lib/types';
import { elevation, layout, motion, palette, radius, spacing, type } from '@/theme';

/** Track inset around the thumb, in px. Derived locally. */
const TRACK_PAD = 3;
const TRACK_HEIGHT = 38;
/** Fallback width until the first layout pass lands. */
const ASSUMED_WIDTH = 200;

export type ModeSwitchProps = {
  style?: StyleProp<ViewStyle>;
};

export function ModeSwitch({ style }: ModeSwitchProps) {
  const { mode, setMode } = useMode();
  const { settings } = usePrefs();
  const haptics = useHaptics(settings.haptics);
  const reduceMotion = useReducedMotion();

  const [trackWidth, setTrackWidth] = useState(ASSUMED_WIDTH);
  const segmentWidth = (trackWidth - TRACK_PAD * 2) / MODES.length;

  // 0 = quick, 1 = fashion. One value drives position, colour and both labels.
  const progress = useSharedValue(mode === 'fashion' ? 1 : 0);

  useEffect(() => {
    const target = mode === 'fashion' ? 1 : 0;
    progress.value = reduceMotion ? target : withSpring(target, motion.toggle);
  }, [mode, progress, reduceMotion]);

  const select = useCallback(
    (next: Mode) => {
      if (next === mode) return;
      haptics.selection();
      setMode(next);
    },
    [mode, haptics, setMode]
  );

  const thumbStyle = useAnimatedStyle(() => ({
    width: segmentWidth,
    transform: [{ translateX: progress.value * segmentWidth }],
    backgroundColor: interpolateColor(
      progress.value,
      [0, 1],
      [palette.mode.quick.accent, palette.mode.fashion.accent]
    ),
  }));

  return (
    <View
      accessibilityRole="tablist"
      onLayout={(event) => setTrackWidth(event.nativeEvent.layout.width)}
      style={[styles.track, style]}
    >
      <Animated.View style={[styles.thumb, elevation.thumb, thumbStyle]} />

      {MODES.map((candidate, index) => (
        <ModeSegment
          key={candidate}
          mode={candidate}
          index={index}
          progress={progress}
          selected={candidate === mode}
          onPress={() => select(candidate)}
        />
      ))}
    </View>
  );
}

type ModeSegmentProps = {
  mode: Mode;
  index: number;
  progress: ReturnType<typeof useSharedValue<number>>;
  selected: boolean;
  onPress: () => void;
};

function ModeSegment({ mode, index, progress, selected, onPress }: ModeSegmentProps) {
  // Distance from this segment to the thumb: 0 when covered, 1 when not.
  const distance = useDerivedValue(() => Math.abs(progress.value - index));

  const labelStyle = useAnimatedStyle(() => ({
    color: interpolateColor(
      distance.value,
      [0, 1],
      [palette.textInverse, palette.textSecondary]
    ),
    // A hair of lift on the covered label so the active mode reads first.
    transform: [{ scale: interpolate(distance.value, [0, 1], [1, 0.97]) }],
  }));

  return (
    <PressableScale
      accessibilityRole="tab"
      accessibilityState={{ selected }}
      accessibilityLabel={`${MODE_SHORT_LABEL[mode]} mode`}
      haptic={false}
      activeScale={0.98}
      onPress={onPress}
      style={styles.segment}
    >
      <Animated.Text maxFontSizeMultiplier={1.1} style={[styles.label, labelStyle]}>
        {MODE_SHORT_LABEL[mode]}
      </Animated.Text>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  track: {
    flexDirection: 'row',
    height: TRACK_HEIGHT,
    padding: TRACK_PAD,
    borderRadius: radius.pill,
    backgroundColor: palette.surfaceRaised,
    borderWidth: layout.hairline,
    borderColor: palette.line,
  },
  thumb: {
    position: 'absolute',
    top: TRACK_PAD,
    left: TRACK_PAD,
    bottom: TRACK_PAD,
    borderRadius: radius.pill,
  },
  segment: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
  },
  label: {
    ...type.label,
  },
});
