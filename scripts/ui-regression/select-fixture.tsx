import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { NativeSelect, NativeSelectOption as Option, NativeSelectOptGroup } from '../../ui/src/components/ui/native-select';
import '../../ui/src/theme.css';
import '../../ui/src/fonts.css';
import '../../ui/src/styles.css';
import '../../ui/src/stitch.css';

function Fixture() {
  const [value, setValue] = useState('b');
  const [disabled, setDisabled] = useState(false);
  const [changes, setChanges] = useState(0);
  const [formChanges, setFormChanges] = useState(0);
  const [submitted, setSubmitted] = useState('');
  const [extra, setExtra] = useState(false);
  return <main style={{ padding: 24, maxWidth: 480 }}>
    <form id="fixture-form" onChange={() => setFormChanges(n => n + 1)} onSubmit={event => {
      event.preventDefault(); setSubmitted(JSON.stringify([...new FormData(event.currentTarget)]));
    }}>
      <label>默认职责<NativeSelect name="purpose" defaultValue="b" onChange={() => setChanges(n => n + 1)}>
        <Option value="">不配置</Option><Option value="a">Alpha</Option><Option value="b">Beta</Option>
        <Option value="value:">带前缀的真实值</Option><Option value="off" disabled>不可用</Option>
        <NativeSelectOptGroup label="不可用组" disabled><Option value="group-off">组内不可用</Option></NativeSelectOptGroup>
      </NativeSelect></label>
      <label htmlFor="controlled">受控模型</label><NativeSelect id="controlled" name="model" value={value} onChange={e => setValue(e.target.value)}>
        <Option value="a">Alpha</Option><Option value="b">Beta</Option>{extra && <Option value="c">Gamma</Option>}
      </NativeSelect>
      <label>必填连接<NativeSelect name="required" required><Option value="">选择连接</Option><Option value="ok">已登记连接</Option></NativeSelect></label>
      <fieldset disabled={disabled}><legend>保存中的表单</legend><label>继承禁用<NativeSelect name="fieldset" defaultValue="b"><Option value="a">Alpha</Option><Option value="b">Beta</Option></NativeSelect></label></fieldset>
      <label>直接禁用<NativeSelect name="disabled" disabled defaultValue="a"><Option value="a">Alpha</Option></NativeSelect></label>
      <label>长路径<NativeSelect name="long"><Option value="long">{'/workspace/long-unbroken-name-'.repeat(12)}</Option>{Array.from({ length: 30 }, (_, i) => <Option key={i} value={`path-${i}`}>工作目录 {i}</Option>)}</NativeSelect></label>
      <button type="reset">重置</button><button type="submit">提交</button>
    </form>
    <label>外部关联字段<NativeSelect form="fixture-form" name="external" defaultValue="b"><Option value="a">Alpha</Option><Option value="b">Beta</Option></NativeSelect></label>
    <button onClick={() => setDisabled(v => !v)}>切换 fieldset 禁用</button>
    <button onClick={() => { setExtra(true); setValue('c'); }}>更新模型选项</button>
    <output data-testid="changes">{changes}</output><output data-testid="form-changes">{formChanges}</output>
    <output data-testid="submitted">{submitted}</output>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
