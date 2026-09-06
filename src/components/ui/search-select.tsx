import { useState } from "react"
import { Popover } from "radix-ui"
import { Check, ChevronDown } from "lucide-react"
import {
  Command,
  CommandInput,
  CommandItem,
  CommandList,
  CommandEmpty,
} from "./command"
export function SearchSelect({
  label,
  value,
  onChange,
  options,
  mobileIcon: MobileIcon,
}: {
  mobileIcon?: import("lucide-react").LucideIcon
  label: string
  value: string
  onChange: (value: string) => void
  options: { value: string; label: string }[]
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          className={`select-trigger ${MobileIcon ? "mobile-icon-select" : ""}`}
          role="combobox"
          aria-expanded={open}
          aria-label={label}
          title={options.find((option) => option.value === value)?.label}
          data-active={value !== options[0]?.value || undefined}
        >
          {MobileIcon && (
            <MobileIcon className="mobile-filter-icon" size={18} />
          )}
          <span>
            {options.find((option) => option.value === value)?.label ??
              options[0]?.label}
          </span>
          <ChevronDown size={14} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="tag-popover"
          sideOffset={5}
          align="start"
          collisionPadding={12}
        >
          <Command loop>
            <CommandInput
              placeholder="Search…"
              aria-label={`Search ${label.toLowerCase()}`}
            />
            <CommandList className="tag-options">
              <CommandEmpty>No matches.</CommandEmpty>
              {options.map((option) => (
                <CommandItem
                  key={option.value}
                  value={option.value}
                  keywords={[option.label]}
                  onSelect={() => {
                    onChange(option.value)
                    setOpen(false)
                  }}
                >
                  {option.label}
                  {value === option.value && <Check size={14} />}
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
