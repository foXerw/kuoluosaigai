<template>
  <div class="hello">
    <h1>{{ msg }}</h1>
    <button @click="incrementCount">{{ count }}</button>
  </div>
</template>

<script>
import axios from 'axios';

export default {
  name: 'HelloWorld',
  props: {
    msg: String
  },
  data() {
    return {
      count: 0,
    };
  },
  methods: {
    async incrementCount() {
      try {
        // 这里替换为您的实际API URL
        const response = await axios.get('http://kuoluosaigai.com:8000/api/nothing');

        if (response.status === 200) {
          this.count = response.data.count;
        } else {
          console.error('Error fetching data:', response.statusText);
        }
      } catch (error) {
        console.error('Request failed with error:', error);
      }
    },
  },
};
</script>

<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>
h3 {
  margin: 40px 0 0;
}

ul {
  list-style-type: none;
  padding: 0;
}

li {
  display: inline-block;
  margin: 0 10px;
}

a {
  color: #42b983;
}

.custom-button {
  font-size: 18px; /* 设置字体大小 */
  padding: 500px 500px; /* 设置内边距以增大按钮面积 */
  width: 300px; /* 设置固定宽度 */
  height: 500px; /* 设置固定高度 */
}
</style>
