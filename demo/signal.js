const samples = [0.12, 0.48, 0.75, 0.92, 0.68, 0.31];

function average(values) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

export function describeSignal(values = samples) {
  return {
    count: values.length,
    mean: average(values),
    peak: Math.max(...values),
  };
}
