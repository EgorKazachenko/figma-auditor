export const Button = () => (
  <button
    className="bg-[#123456] p-[13px] px-[8px] w-[300px] rounded-[7px] text-[13px]"
    style={{ color: "#ff0000", "--local-gap": "4px", gap: "var(--local-gap)" } as never}
  >
    {/* comment #abcdef */}
    <span style={{ background: "var(--color-level-5)", border: "var(--color-unknown-x)" }}>Go</span>
    <span className="p-[13px] p-[13px]" />
  </button>
);
