import { Select as Primitive } from "radix-ui"
import { Check, ChevronDown, ChevronUp } from "lucide-react"
export function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <Primitive.Root value={value} onValueChange={onChange}>
      <Primitive.Trigger className="select-trigger" aria-label={label}>
        <Primitive.Value />
        <Primitive.Icon>
          <ChevronDown size={14} />
        </Primitive.Icon>
      </Primitive.Trigger>
      <Primitive.Portal>
        <Primitive.Content
          className="select-content"
          position="popper"
          sideOffset={5}
          collisionPadding={12}
        >
          <Primitive.ScrollUpButton>
            <ChevronUp size={14} />
          </Primitive.ScrollUpButton>
          <Primitive.Viewport>
            {options.map((option) => (
              <Primitive.Item
                className="select-item"
                key={option.value}
                value={option.value}
              >
                <Primitive.ItemText>{option.label}</Primitive.ItemText>
                <Primitive.ItemIndicator>
                  <Check size={14} />
                </Primitive.ItemIndicator>
              </Primitive.Item>
            ))}
          </Primitive.Viewport>
          <Primitive.ScrollDownButton>
            <ChevronDown size={14} />
          </Primitive.ScrollDownButton>
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  )
}
