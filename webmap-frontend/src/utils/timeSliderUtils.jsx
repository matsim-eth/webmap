export const marks = {
  0: "00:00",
  24: "06:00",
  48: "12:00",
  72: "18:00",
  96: "24:00",
};

export const formatTimeLabel = (index) => {
  const hours = Math.floor(index / 4)
    .toString()
    .padStart(2, "0");
  const minutes = ((index % 4) * 15).toString().padStart(2, "0");
  return `${hours}:${minutes}`;
};
