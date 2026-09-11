/**
 * The base for every tappable surface in Bachat.
 *
 * Press-in springs the target to 0.97 and dims it slightly; press-out springs
 * back. Both run on the UI thread via Reanimated so a busy JS thread (ranking a
 * basket, decoding a deals feed) never makes taps feel dead.
 *
 * The scale floor is shallower than a chat app's: these are dense 64px rows in
 * a list, and a deep squash on one row visibly shoves its neighbours.
 */

import { forwardRef, useCallback, useEffect } from 'react';
import {
  Pressable,
  type GestureResponderEvent,
  type PressableProps,
  type StyleProp,
  type View,
  type ViewStyle,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { useHaptics } from '@/hooks/use-haptics';
import { motion } from '@/theme';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/** Scale floor on press-in. Derived locally — tokens carry no scale ramp. */
const PRESSED_SCALE = 0.97;
/** Opacity floor on press-in. Derived locally for the same reason. */
const PRESSED_OPACITY = 0.84;
/** Opacity for the disabled state. Derived locally. */
const DISABLED_OPACITY = 0.42;

export type PressableScaleProps = Omit<PressableProps, 'style'> & {
  /** Static style only — the press transform is composed on top of it. */
  style?: StyleProp<ViewStyle>;
  /** Haptic fired on press-in. `false` disables it for this element. */
  haptic?: 'tap' | 'selection' | false;
  /** Wire to `settings.haptics`. Defaults to on. */
  hapticsEnabled?: boolean;
  /** Override the press-in scale, e.g. `0.99` for a full-width card. */
  activeScale?: number;
};

export const PressableScale = forwardRef<View, PressableScaleProps>(function PressableScale(
  {
    style,
    haptic = 'tap',
    hapticsEnabled = true,
    activeScale = PRESSED_SCALE,
    disabled,
    onPressIn,
    onPressOut,
    accessibilityRole = 'button',
    ...rest
  },
  ref
) {
  const progress = useSharedValue(0);
  const reduceMotion = useReducedMotion();
  const haptics = useHaptics(hapticsEnabled);

  const handlePressIn = useCallback(
    (event: GestureResponderEvent) => {
      progress.value = reduceMotion ? 1 : withSpring(1, motion.snappy);
      if (haptic === 'tap') haptics.tap();
      else if (haptic === 'selection') haptics.selection();
      onPressIn?.(event);
    },
    [progress, reduceMotion, haptic, haptics, onPressIn]
  );

  const handlePressOut = useCallback(
    (event: GestureResponderEvent) => {
      progress.value = reduceMotion ? 0 : withSpring(0, motion.snappy);
      onPressOut?.(event);
    },
    [progress, reduceMotion, onPressOut]
  );

  const enabledOpacity = useSharedValue(disabled ? DISABLED_OPACITY : 1);

  useEffect(() => {
    enabledOpacity.value = withTiming(disabled ? DISABLED_OPACITY : 1, {
      duration: motion.duration.fast,
    });
  }, [disabled, enabledOpacity]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 - progress.value * (1 - activeScale) }],
    opacity: enabledOpacity.value * (1 - progress.value * (1 - PRESSED_OPACITY)),
  }));

  return (
    <AnimatedPressable
      ref={ref}
      disabled={disabled}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      accessibilityRole={accessibilityRole}
      accessibilityState={{ disabled: !!disabled }}
      style={[style, animatedStyle]}
      {...rest}
    />
  );
});
