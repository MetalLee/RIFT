import * as React from "react"
import { Select } from "radix-ui"
import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from "lucide-react"

type Option = { value: string; label: string; disabled: boolean; group: string | null }

// Keep the native field as the authority for HTML form semantics; Radix owns only the UI.
function NativeSelect({
  className, size = "default", children, ref, id, style, onChange, onInvalid,
  ...props
}: Omit<React.ComponentProps<"select">, "size" | "multiple"> & { size?: "sm" | "default" }) {
  const native = React.useRef<HTMLSelectElement>(null)
  const trigger = React.useRef<HTMLButtonElement>(null)
  const errorId = React.useId()
  const [options, setOptions] = React.useState<Option[]>([])
  const [selected, setSelected] = React.useState("")
  const [disabled, setDisabled] = React.useState(!!props.disabled)
  const [open, setOpen] = React.useState(false)
  const [error, setError] = React.useState("")
  React.useImperativeHandle(ref, () => native.current!, [])

  const sync = React.useCallback(() => {
    const field = native.current
    if (!field) return
    setSelected(field.value)
    const isDisabled = field.matches(":disabled")
    setDisabled(isDisabled)
    if (isDisabled) setOpen(false)
    const next = Array.from(field.options, option => ({
      value: option.value, label: option.label,
      disabled: option.disabled || (option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled),
      group: option.parentElement instanceof HTMLOptGroupElement ? option.parentElement.label : null,
    }))
    setOptions(current => JSON.stringify(current) === JSON.stringify(next) ? current : next)
    if (field.validity.valid) setError("")
  }, [])

  // Read the browser's selection after controlled updates, option changes and native defaults.
  React.useLayoutEffect(sync)
  React.useEffect(() => {
    const field = native.current!
    let resetTimer: ReturnType<typeof setTimeout>
    // The reset event precedes the browser's default action, including its microtask checkpoint.
    const reset = (event: Event) => { resetTimer = setTimeout(() => {
      if (!event.defaultPrevented) { sync(); setError(""); setOpen(false) }
    }, 0) }
    const form = field.form
    form?.addEventListener("reset", reset)
    const observer = new MutationObserver(sync)
    for (let ancestor = field.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor instanceof HTMLFieldSetElement) observer.observe(ancestor, { attributes: true, attributeFilter: ["disabled"] })
    }
    return () => { form?.removeEventListener("reset", reset); clearTimeout(resetTimer); observer.disconnect() }
  }, [sync, props.form])

  const current = options.find(option => option.value === selected)
  // Prefix *every* value, including empty, so Radix's reserved empty string never collides.
  const encode = (value: string) => `value:${value}`
  return (
    <div data-slot="native-select-wrapper" style={style} onChange={event => {
      // Radix's unnamed internal field must not emit a second form change.
      if ((event.target as EventTarget) !== native.current) event.stopPropagation()
    }}>
      {/* Only the native field below participates in form submission and reset. */}
      <Select.Root form={errorId} value={current ? encode(selected) : ""} disabled={disabled} open={open && !disabled}
        onOpenChange={setOpen} onValueChange={value => {
          const field = native.current!
          if (field.matches(":disabled")) return
          field.value = value.slice(6)
          field.dispatchEvent(new Event("change", { bubbles: true }))
          sync()
        }}>
        <Select.Trigger ref={trigger} id={id} data-slot="select-trigger" data-size={size}
          className={className} title={props.title ?? current?.label}
          aria-label={props["aria-label"]} aria-labelledby={props["aria-labelledby"]}
          aria-describedby={[props["aria-describedby"], error ? errorId : ""].filter(Boolean).join(" ") || undefined}
          aria-invalid={error ? true : props["aria-invalid"]} aria-required={props.required}
          autoFocus={props.autoFocus} tabIndex={props.tabIndex}>
          <Select.Value>{current?.label ?? ""}</Select.Value>
          <Select.Icon asChild><ChevronDownIcon aria-hidden="true" size={16} /></Select.Icon>
        </Select.Trigger>
        <Select.Portal>
          <Select.Content data-slot="select-content" position="popper" sideOffset={4} collisionPadding={12}>
            <Select.ScrollUpButton className="rift-select-scroll"><ChevronUpIcon aria-hidden="true" size={16} /></Select.ScrollUpButton>
            <Select.Viewport className="rift-select-viewport">
              {options.map((option, index) => <React.Fragment key={`${index}:${option.value}`}>
                {option.group !== null && option.group !== options[index - 1]?.group && <div className="rift-select-group">{option.group}</div>}
                <Select.Item data-slot="select-item" value={encode(option.value)} disabled={option.disabled} textValue={option.label}>
                  <Select.ItemText>{option.label}</Select.ItemText>
                  <Select.ItemIndicator className="rift-select-check"><CheckIcon aria-hidden="true" size={16} /></Select.ItemIndicator>
                </Select.Item>
              </React.Fragment>)}
            </Select.Viewport>
            <Select.ScrollDownButton className="rift-select-scroll"><ChevronDownIcon aria-hidden="true" size={16} /></Select.ScrollDownButton>
          </Select.Content>
        </Select.Portal>
      </Select.Root>
      <select {...props} ref={native} data-slot="select-native" aria-hidden="true" tabIndex={-1}
        autoFocus={false} onFocus={() => trigger.current?.focus()}
        onChange={event => { onChange?.(event); sync() }}
        onInvalid={event => {
          onInvalid?.(event)
          if (!event.defaultPrevented) {
            event.preventDefault()
            setError(event.currentTarget.validationMessage)
            trigger.current?.focus()
          }
        }}>{children}</select>
      {error && <span id={errorId} className="form-error" role="alert">{error}</span>}
    </div>
  )
}

function NativeSelectOption(props: React.ComponentProps<"option">) {
  return <option {...props} />
}

function NativeSelectOptGroup(props: React.ComponentProps<"optgroup">) {
  return <optgroup {...props} />
}

export { NativeSelect, NativeSelectOptGroup, NativeSelectOption }
