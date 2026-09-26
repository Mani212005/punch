export default function handler(
  _req: { method?: string },
  res: { status: (code: number) => { json: (data: unknown) => void } },
) {
  res.status(200).json({ alive: true });
}
