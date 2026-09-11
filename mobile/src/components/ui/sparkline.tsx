/**
 * Thirty days of price history, thirty-four pixels tall.
 *
 * This is a shape, not a chart: no axes, no gridlines, no tooltip. The question
 * it answers is "is today unusually cheap?", and the answer is the position of
 * the last point against the band. A dot marks today; when today sits at the
 * recorded low, the dot and the fill turn green.
 *
 * It renders whatever history exists, including twelve days. Padding a short
 * series out to thirty would be the visual form of the lie spec §7 forbids, so
 * a short series simply draws short and the caller labels it honestly.
 */

import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Circle, Line, Path } from 'react-native-svg';

import type { PricePoint } from '@/lib/types';
import { layout, palette, spacing, type } from '@/theme';

/** Vertical breathing room so the stroke is never clipped. Derived locally. */
const PAD_Y = 3;
const STROKE = 1.75;
const DOT = 3;

export type SparklineProps = {
  points: PricePoint[];
  /** Drawing width in px. Give it the measured width of its container. */
  width: number;
  height?: number;
  /** Green line and fill: today is the lowest price we have recorded. */
  atLow?: boolean;
  /** Renders "12 days" under the line. Pass the real N (spec §7). */
  showDayCount?: boolean;
  style?: StyleProp<ViewStyle>;
};

/** Builds the polyline and a matching closed area path in one pass. */
function buildPaths(
  points: PricePoint[],
  width: number,
  height: number
): { line: string; area: string; lastX: number; lastY: number } | null {
  if (points.length < 2 || width <= 0) return null;

  const values = points.map((point) => point.minPrice);
  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = high - low;
  const usableHeight = height - PAD_Y * 2;
  const step = width / (points.length - 1);

  const coords = values.map((value, index) => {
    const x = index * step;
    // A flat series would divide by zero; park it on the centre line instead.
    const ratio = span === 0 ? 0.5 : (value - low) / span;
    const y = PAD_Y + (1 - ratio) * usableHeight;
    return { x, y };
  });

  const line = coords
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(2)},${point.y.toFixed(2)}`)
    .join(' ');

  const first = coords[0];
  const last = coords[coords.length - 1];
  if (!first || !last) return null;

  const area = `${line} L${last.x.toFixed(2)},${height} L${first.x.toFixed(2)},${height} Z`;
  return { line, area, lastX: last.x, lastY: last.y };
}

export function Sparkline({
  points,
  width,
  height = layout.sparklineHeight,
  atLow = false,
  showDayCount = false,
  style,
}: SparklineProps) {
  const paths = buildPaths(points, width, height);
  const stroke = atLow ? palette.save : palette.textSecondary;

  if (!paths) {
    // One data point is not a trend. Say so rather than drawing a fake line.
    return (
      <View style={[styles.empty, { width, height }, style]}>
        <Text maxFontSizeMultiplier={1.2} style={styles.emptyText}>
          Not enough history yet
        </Text>
      </View>
    );
  }

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={`Price over the last ${points.length} days${
        atLow ? ', currently at its lowest' : ''
      }`}
      style={style}
    >
      <Svg width={width} height={height}>
        <Path d={paths.area} fill={atLow ? palette.saveWash : palette.surfaceRaised} />
        <Line
          x1={0}
          y1={height - 0.5}
          x2={width}
          y2={height - 0.5}
          stroke={palette.line}
          strokeWidth={layout.hairline}
        />
        <Path
          d={paths.line}
          stroke={stroke}
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
        <Circle cx={paths.lastX} cy={paths.lastY} r={DOT} fill={stroke} />
      </Svg>
      {showDayCount ? (
        <Text maxFontSizeMultiplier={1.2} style={styles.dayCount}>
          {points.length === 1 ? '1 day of history' : `${points.length} days of history`}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  empty: {
    alignItems: 'flex-start',
    justifyContent: 'center',
  },
  emptyText: {
    ...type.caption,
    color: palette.textMuted,
  },
  dayCount: {
    ...type.tag,
    color: palette.textMuted,
    marginTop: spacing.xs,
  },
});
